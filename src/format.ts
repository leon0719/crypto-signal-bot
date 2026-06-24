// 把分析結果格式化成 LINE Flex 圖卡 + quick reply。

import {
  type AnalyzeCommand,
  Direction,
  type DirectionValue,
  type Flex,
  type HtfInfo,
  type Indicators,
  type LineMessage,
  type Market,
  type QuickReply,
  type Result,
} from "./types.js";

const COLOR = {
  long: "#16a34a",
  short: "#dc2626",
  neutral: "#d97706",
  sub: "#8c8c8c",
  text: "#333333",
};

const QR_MAX_ITEMS = 13; // LINE quick reply 上限
const QR_MAX_LABEL = 20; // LINE 按鈕文字上限
const ALT_TEXT_MAX = 400; // LINE flex altText 上限
const INTERVALS = ["5m", "15m", "1h", "4h", "1d"];

function fmtNum(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function dirColor(dir: DirectionValue): string {
  if (dir === Direction.Long) return COLOR.long;
  if (dir === Direction.Short) return COLOR.short;
  return COLOR.neutral;
}

function dirLabel(dir: DirectionValue): string {
  if (dir === Direction.Long) return "做多 ▲";
  if (dir === Direction.Short) return "做空 ▼";
  return "觀望 ―";
}

function conviction(score: number): string {
  const a = Math.abs(score);
  if (a >= 60) return "強烈";
  if (a >= 25) return "中等";
  return "分歧";
}

// 兩欄一列(左標題、右內容),右側可上色。
function kvRow(label: string, value: string, color: string = COLOR.text, weight = "regular"): Flex {
  return {
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: label, size: "sm", color: COLOR.sub, flex: 2 },
      { type: "text", text: value, size: "sm", color, weight, flex: 5, align: "end" },
    ],
  };
}

const separator = (): Flex => ({ type: "separator", margin: "md" });

interface Plan {
  entry: number;
  zoneLo: number;
  zoneHi: number;
  levelName: string;
  stop: number;
  target: number;
  lossPct: number;
  winPct: number;
  rr: number;
}

// 估「理想限價進場」:等回拉到最近的支撐(做多)/壓力(做空),沒有合適的就用 0.5×ATR 回拉。
// 停損停利改以該理想進場價計算 —— 進得越好,風險越低。沒人能保證會回拉到,純技術參考。
function entryPlan(ind: Indicators, res: Result, isLong: boolean): Plan {
  const i = res.index;
  const price = res.price;
  const atr = res.atr;
  const cfg = ind.cfg;

  // 候選支撐/壓力:只取落在現價 1.2×ATR 內、且在進場方向正確一側的。
  const cands: Array<[string, number]> = isLong
    ? [
        ["EMA12", ind.emaFast[i]],
        ["EMA50", ind.emaMid[i]],
        ["布林下軌", ind.bbLower[i]],
      ]
    : [
        ["EMA12", ind.emaFast[i]],
        ["EMA50", ind.emaMid[i]],
        ["布林上軌", ind.bbUpper[i]],
      ];
  const inBand = cands.filter(([, v]) =>
    isLong ? v < price && v >= price - 1.2 * atr : v > price && v <= price + 1.2 * atr,
  );
  inBand.sort((a, b) => Math.abs(price - a[1]) - Math.abs(price - b[1]));

  const pull = isLong ? price - 0.5 * atr : price + 0.5 * atr;
  const entry = inBand.length ? inBand[0][1] : pull;
  const levelName = inBand.length
    ? `${inBand[0][0]}（${isLong ? "支撐" : "壓力"}）`
    : "回拉 0.5×ATR";

  const band = 0.2 * atr;
  const stop = isLong ? entry - cfg.stopATR * atr : entry + cfg.stopATR * atr;
  const target = isLong ? entry + cfg.takeATR * atr : entry - cfg.takeATR * atr;
  const lossPct = (Math.abs(stop - entry) / entry) * 100;
  const winPct = (Math.abs(target - entry) / entry) * 100;
  return {
    entry,
    zoneLo: entry - band,
    zoneHi: entry + band,
    levelName,
    stop,
    target,
    lossPct,
    winPct,
    rr: winPct / lossPct,
  };
}

// 觀望時的說明:大週期牴觸 / 量能不足 / 多空分歧,擇一。
function neutralNote(ind: Indicators, res: Result, htf?: HtfInfo): string {
  if (htf?.conflict) return "📌 大週期方向相反,降級為觀望,不建議逆勢進場。";
  const gatedByVolume =
    Math.abs(res.score) >= ind.cfg.entryThreshold &&
    !Number.isNaN(res.volRatio) &&
    res.volRatio < ind.cfg.volumeMult;
  if (gatedByVolume) {
    return `📌 訊號偏${res.score > 0 ? "多" : "空"}但量能不足(${res.volRatio.toFixed(1)}× 均量),等放量再進場。`;
  }
  return "📌 多空分歧,建議觀望,等評分明確再進場。";
}

// 組一張 bubble(單卡與 carousel 共用)。
export function buildBubble(
  meta: AnalyzeCommand,
  ind: Indicators,
  res: Result,
  htf?: HtfInfo,
): Flex {
  const marketZh = meta.market === "spot" ? "現貨" : "合約";
  const accent = dirColor(res.direction);
  const body: Flex[] = [];

  body.push({
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: "價格", size: "sm", color: COLOR.sub, flex: 2 },
      {
        type: "text",
        text: fmtNum(res.price),
        size: "xl",
        weight: "bold",
        color: COLOR.text,
        flex: 5,
        align: "end",
      },
    ],
  });

  body.push({
    type: "box",
    layout: "baseline",
    margin: "md",
    contents: [
      {
        type: "text",
        text: dirLabel(res.direction),
        size: "lg",
        weight: "bold",
        color: accent,
        flex: 3,
      },
      {
        type: "text",
        text: `${res.score >= 0 ? "+" : ""}${res.score.toFixed(0)} / 100`,
        size: "sm",
        color: accent,
        flex: 4,
        align: "end",
      },
    ],
  });
  body.push(kvRow("信心", conviction(res.score)));
  body.push(kvRow("市場狀態", `${res.regime}｜ADX ${res.adx.toFixed(0)}`));

  // 多週期確認。
  if (htf) {
    const label = `大週期 ${htf.interval}`;
    const value = htf.conflict ? "方向牴觸 ✗" : "方向一致 ✓";
    body.push(kvRow(label, value, htf.conflict ? COLOR.short : COLOR.long, "bold"));
  }

  body.push(separator());
  body.push({
    type: "text",
    text: res.components
      .map((c) => `${c.name}${c.value > 0 ? "▲" : c.value < 0 ? "▼" : "―"}`)
      .join("  "),
    size: "xs",
    color: COLOR.sub,
    wrap: true,
    margin: "md",
  });

  body.push(separator());
  // 大週期牴觸時降級為觀望。
  const effectiveDir = htf?.conflict ? Direction.Neutral : res.direction;
  if (effectiveDir === Direction.Neutral) {
    body.push({
      type: "text",
      text: neutralNote(ind, res, htf),
      size: "sm",
      color: COLOR.text,
      wrap: true,
      margin: "md",
    });
  } else {
    const isLong = effectiveDir === Direction.Long;
    const p = entryPlan(ind, res, isLong);

    body.push({
      type: "text",
      text: "🎯 交易規劃",
      size: "sm",
      weight: "bold",
      color: COLOR.text,
      margin: "md",
    });
    // 理想限價區(等回拉到支撐/壓力,進場價較佳;現價已顯示在最上方)。
    body.push(kvRow("理想進場", `${fmtNum(p.zoneLo)} ~ ${fmtNum(p.zoneHi)}`, COLOR.text, "bold"));
    body.push(kvRow("　靠近", p.levelName));
    body.push(kvRow("停損", `${fmtNum(p.stop)}  (-${p.lossPct.toFixed(1)}%)`, COLOR.short, "bold"));
    body.push(kvRow("停利", `${fmtNum(p.target)}  (+${p.winPct.toFixed(1)}%)`, COLOR.long, "bold"));
    body.push(kvRow("賺賠比", `${p.rr.toFixed(1)} : 1`));

    if (meta.leverage > 1 && meta.market === "futures") {
      body.push(separator());
      for (const row of leverageRows(meta.leverage, isLong, p.entry, p.lossPct, p.winPct))
        body.push(row);
    }
  }

  return {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: accent,
      paddingAll: "md",
      contents: [
        { type: "text", text: meta.symbol, color: "#ffffff", weight: "bold", size: "lg" },
        {
          type: "text",
          text: `OKX ${marketZh} · ${meta.interval}`,
          color: "#ffffffcc",
          size: "xs",
        },
      ],
    },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
  };
}

// 單卡訊息。
export function buildFlexMessage(
  meta: AnalyzeCommand,
  ind: Indicators,
  res: Result,
  htf?: HtfInfo,
): LineMessage {
  const bubble = buildBubble(meta, ind, res, htf);
  const altText = `${meta.symbol} ${dirLabel(res.direction)} 評分${res.score.toFixed(0)} 價${fmtNum(res.price)}`;
  return {
    type: "flex",
    altText: altText.slice(0, ALT_TEXT_MAX),
    contents: bubble,
    quickReply: intervalQuickReply(meta),
  };
}

// 多週期 carousel 訊息。
export function buildCarouselMessage(symbol: string, bubbles: Flex[]): LineMessage {
  return {
    type: "flex",
    altText: `${symbol} 多週期分析`.slice(0, ALT_TEXT_MAX),
    contents: { type: "carousel", contents: bubbles },
    quickReply: symbolQuickReply(),
  };
}

function leverageRows(
  lev: number,
  isLong: boolean,
  px: number,
  lossPct: number,
  winPct: number,
): Flex[] {
  const marginLoss = lossPct * lev;
  const marginGain = winPct * lev;
  const liqDist = 100 / lev;
  const liqPrice = isLong ? px * (1 - 1 / lev) : px * (1 + 1 / lev);
  const rows: Flex[] = [
    {
      type: "text",
      text: `⚡ 槓桿 ${lev}×`,
      size: "sm",
      weight: "bold",
      color: COLOR.text,
      margin: "md",
    },
    kvRow("保證金盈虧", `+${marginGain.toFixed(0)}% / -${marginLoss.toFixed(0)}%`),
    kvRow("強平價", `~${fmtNum(liqPrice)} (${liqDist.toFixed(1)}%)`),
  ];
  if (lossPct >= liqDist) {
    rows.push(
      kvRow(
        "⚠ 風險",
        `停損比強平遠,會先爆倉!建議 ≤${Math.floor(100 / lossPct)}×`,
        COLOR.short,
        "bold",
      ),
    );
  } else if (lossPct >= liqDist * 0.7) {
    rows.push(kvRow("⚠ 風險", "停損接近強平,建議降槓桿", COLOR.neutral));
  } else {
    rows.push(kvRow("風險", "停損在強平之前 ✓", COLOR.long));
  }
  return rows;
}

// 由 [label, text] 配對建立 quick reply(集中處理 LINE 的數量/字數上限)。
function quickReply(pairs: Array<[string, string]>): QuickReply {
  return {
    items: pairs.slice(0, QR_MAX_ITEMS).map(([label, text]) => ({
      type: "action",
      action: { type: "message", label: String(label).slice(0, QR_MAX_LABEL), text },
    })),
  };
}

function marketSuffix(meta: AnalyzeCommand): string {
  return `${meta.market === "spot" ? " spot" : ""}${meta.leverage > 1 ? ` ${meta.leverage}x` : ""}`;
}

// 換週期按鈕 + 多週期捷徑,沿用原本市場別/槓桿。
function intervalQuickReply(meta: AnalyzeCommand): QuickReply {
  const suffix = marketSuffix(meta);
  const pairs: Array<[string, string]> = INTERVALS.map((iv) => [
    iv,
    `${meta.symbol} ${iv}${suffix}`,
  ]);
  pairs.push(["多週期", `${meta.symbol} multi${suffix}`]);
  return quickReply(pairs);
}

// 由模糊查詢結果建立 quick reply(點按鈕直接查該幣,沿用原本市場別)。
export function suggestionQuickReply(bases: string[], market: Market): QuickReply {
  const suffix = market === "spot" ? " spot" : "";
  return quickReply(bases.map((b) => [b, `${b}${suffix}`]));
}

// 給 help / 錯誤訊息用的常用幣別按鈕。
export function symbolQuickReply(): QuickReply {
  return quickReply((["BTC", "ETH", "SOL", "BNB", "XRP"] as const).map((c) => [c, c]));
}
