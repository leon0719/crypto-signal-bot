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

// 組一張 bubble(單卡與 carousel 共用)。
export function buildBubble(
  meta: AnalyzeCommand,
  ind: Indicators,
  res: Result,
  funding: number | null,
  htf?: HtfInfo,
): Flex {
  const cfg = ind.cfg;
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
  if (funding != null) body.push(kvRow("資金費率", `${(funding * 100).toFixed(4)}% / 8h`));

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
      text: htf?.conflict
        ? "📌 大週期方向相反,降級為觀望,不建議逆勢進場。"
        : "📌 多空分歧,建議觀望,等評分明確再進場。",
      size: "sm",
      color: COLOR.text,
      wrap: true,
      margin: "md",
    });
  } else {
    const isLong = effectiveDir === Direction.Long;
    const px = res.price;
    const atr = res.atr;
    const stop = isLong ? px - cfg.stopATR * atr : px + cfg.stopATR * atr;
    const target = isLong ? px + cfg.takeATR * atr : px - cfg.takeATR * atr;
    const lossPct = (Math.abs(stop - px) / px) * 100;
    const winPct = (Math.abs(target - px) / px) * 100;
    const rr = winPct / lossPct;

    body.push({
      type: "text",
      text: "🎯 交易規劃",
      size: "sm",
      weight: "bold",
      color: COLOR.text,
      margin: "md",
    });
    body.push(kvRow("進場", `~${fmtNum(px)}`));
    body.push(kvRow("停損", `${fmtNum(stop)}  (-${lossPct.toFixed(1)}%)`, COLOR.short, "bold"));
    body.push(kvRow("停利", `${fmtNum(target)}  (+${winPct.toFixed(1)}%)`, COLOR.long, "bold"));
    body.push(kvRow("賺賠比", `${rr.toFixed(1)} : 1`));

    if (meta.leverage > 1 && meta.market === "futures") {
      body.push(separator());
      for (const row of leverageRows(meta.leverage, isLong, px, lossPct, winPct)) body.push(row);
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
  funding: number | null,
  htf?: HtfInfo,
): LineMessage {
  const bubble = buildBubble(meta, ind, res, funding, htf);
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
