// 把分析結果格式化成 LINE Flex 圖卡 + quick reply。

import { suggestLeverage } from "./risk.js";
import * as ta from "./ta.js";
import {
  type AnalyzeCommand,
  Direction,
  type DirectionValue,
  type Flex,
  type HtfInfo,
  type Indicators,
  type LineMessage,
  type Market,
  type OiInfo,
  type QuickReply,
  type Result,
} from "./types.js";

// 整張卡的有效方向:大週期或 OI 任一明確反向就降級為觀望(方向、配色、規劃一致)。
function computeEffectiveDir(res: Result, htf?: HtfInfo, oi?: OiInfo): DirectionValue {
  return htf?.conflict || oi?.conflict ? Direction.Neutral : res.direction;
}

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
// 只列有正期望的週期:回測顯示 1h 及更短含成本為負期望,故快速鍵僅留 4h(主)與 1d(參考)。
const INTERVALS = ["4h", "1d"];
const SWING_SPAN = 2; // 轉折高低點:左右各 2 根確認

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
// 支撐/壓力候選同時納入動態均線(EMA/布林)與價格的轉折高低點(swing,真正反轉過的水平價位),
// 多種方法重疊處(confluence)更可靠。停損停利改以該理想進場價計算 —— 進得越好,風險越低。
// 沒人能保證會回拉到,純技術參考。
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

  // 價格轉折點:做多取前低(支撐)、做空取前高(壓力)。只掃到當前 K 線為止。
  const { highs, lows } = ta.swingPoints(
    ind.klines.slice(0, i + 1).map((k) => k.high),
    ind.klines.slice(0, i + 1).map((k) => k.low),
    SWING_SPAN,
  );
  for (const lv of isLong ? lows : highs) cands.push([isLong ? "前低" : "前高", lv]);

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
function neutralNote(ind: Indicators, res: Result, htf?: HtfInfo, oi?: OiInfo): string {
  if (res.sr?.conflict) {
    return res.score > 0
      ? "📌 上方緊鄰壓力,追多勝算低,降級為觀望,等突破或回踩再說。"
      : "📌 下方緊鄰支撐,追空勝算低,降級為觀望,等跌破或反彈再說。";
  }
  if (htf?.conflict) return "📌 大週期方向相反,降級為觀望,不建議逆勢進場。";
  if (oi?.conflict) return "📌 未平倉量(OI)正往反向擴張,資金不挺此方向,降級為觀望。";
  const gatedByVolume =
    Math.abs(res.score) >= ind.cfg.entryThreshold &&
    !Number.isNaN(res.volRatio) &&
    res.volRatio < ind.cfg.volumeMult;
  if (gatedByVolume) {
    return `📌 訊號偏${res.score > 0 ? "多" : "空"}但量能不足(${res.volRatio.toFixed(1)}× 均量),等放量再進場。`;
  }
  return "📌 多空分歧,建議觀望,等評分明確再進場。";
}

// 組一張 bubble(單卡內容)。
export function buildBubble(
  meta: AnalyzeCommand,
  ind: Indicators,
  res: Result,
  htf?: HtfInfo,
  oi?: OiInfo,
  livePrice?: number | null,
): Flex {
  const marketZh = meta.market === "spot" ? "現貨" : "合約";
  // 大週期或 OI 牴觸時整張卡降級為觀望(方向、配色、規劃一致),不只降級規劃欄。
  const effectiveDir = computeEffectiveDir(res, htf, oi);
  const accent = dirColor(effectiveDir);
  // 訊號依「已收盤」K 棒(res.price);卡片頭顯示即時價,讓報價貼近市場。
  const hasLive = livePrice != null && Number.isFinite(livePrice);
  const displayPrice = hasLive ? (livePrice as number) : res.price;
  const body: Flex[] = [];

  body.push({
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: hasLive ? "即時價" : "價格", size: "sm", color: COLOR.sub, flex: 2 },
      {
        type: "text",
        text: fmtNum(displayPrice),
        size: "xl",
        weight: "bold",
        color: COLOR.text,
        flex: 5,
        align: "end",
      },
    ],
  });

  if (hasLive) {
    body.push({
      type: "text",
      text: `訊號依 ${meta.interval} 收盤 ${fmtNum(res.price)}`,
      size: "xxs",
      color: COLOR.sub,
      align: "end",
    });
  }

  body.push({
    type: "box",
    layout: "baseline",
    margin: "md",
    contents: [
      {
        type: "text",
        text: dirLabel(effectiveDir),
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

  // OI 趨勢確認(回測驗證的「不反對」過濾:僅明確反向時降級)。
  if (oi) {
    const value = oi.conflict ? "資金反向 ✗" : oi.dir === 0 ? "資金收縮 ―" : "資金同向 ✓";
    const color = oi.conflict ? COLOR.short : oi.dir === 0 ? COLOR.sub : COLOR.long;
    body.push(kvRow("未平倉量(OI)", value, color, "bold"));
  }

  // 支撐/壓力感知(srFilter 開啟才有)。
  if (res.sr) {
    const parts: string[] = [];
    if (!Number.isNaN(res.sr.nearestSup)) parts.push(`支 ${fmtNum(res.sr.nearestSup)}`);
    if (!Number.isNaN(res.sr.nearestRes)) parts.push(`壓 ${fmtNum(res.sr.nearestRes)}`);
    const value = res.sr.conflict ? "緊鄰反向 ✗" : parts.length ? parts.join("｜") : "無明確水平";
    const color = res.sr.conflict ? COLOR.short : COLOR.sub;
    body.push(kvRow("支撐/壓力", value, color, res.sr.conflict ? "bold" : "regular"));
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
  if (effectiveDir === Direction.Neutral) {
    body.push({
      type: "text",
      text: neutralNote(ind, res, htf, oi),
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

    // 出場紀律(無狀態,純文字提示)。
    // 2026-07-23:此處原本建議「2×ATR 移動停損」,依據是 docs §3——但那組數字是在
    // 「停損 2×ATR」的錯誤假設下量的。修正停損倍數後重測(4h、8 主流幣、樣本外、
    // MTF on、含成本):固定 1:3 淨avgR +0.146,移動停損 −0.014。改為建議固定出場。
    const cfg = ind.cfg;
    body.push({
      type: "text",
      text: `🔒 出場紀律:停損與停利同時掛好就別再動它。回測顯示固定 ${cfg.takeATR}:${cfg.stopATR} 出場優於移動停損——提前手動獲利了結會把賺賠比壓垮,而這個策略的勝率本來就靠賠率撐。`,
      size: "xs",
      color: COLOR.sub,
      wrap: true,
      margin: "sm",
    });

    if (meta.leverage > 1 && meta.market === "futures") {
      body.push(separator());
      for (const row of leverageRows(meta.leverage, isLong, p.entry, p.lossPct, p.winPct))
        body.push(row);
    }
  }

  // 依 ATR 波動度的建議槓桿(1x–5x,詳 risk.ts)——期貨一律顯示,與使用者自帶槓桿試算並存。
  if (meta.market === "futures") {
    const suggested = suggestLeverage(res.atr, res.price);
    const atrPct = (res.atr / res.price) * 100;
    body.push(separator());
    body.push(
      kvRow("⚡ 建議槓桿", `${suggested}x(ATR 波動 ${atrPct.toFixed(1)}%)`, COLOR.text, "bold"),
    );
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
          text: `Bybit ${marketZh} · ${meta.interval}`,
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
  oi?: OiInfo,
  livePrice?: number | null,
): LineMessage {
  const bubble = buildBubble(meta, ind, res, htf, oi, livePrice);
  const effectiveDir = computeEffectiveDir(res, htf, oi);
  const shownPrice = livePrice != null && Number.isFinite(livePrice) ? livePrice : res.price;
  const altText = `${meta.symbol} ${dirLabel(effectiveDir)} 評分${res.score.toFixed(0)} 價${fmtNum(shownPrice)}`;
  return {
    type: "flex",
    altText: altText.slice(0, ALT_TEXT_MAX),
    contents: bubble,
    quickReply: intervalQuickReply(meta),
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

// 換週期按鈕,沿用原本市場別/槓桿。
function intervalQuickReply(meta: AnalyzeCommand): QuickReply {
  const suffix = marketSuffix(meta);
  const pairs: Array<[string, string]> = INTERVALS.map((iv) => [
    iv,
    `${meta.symbol} ${iv}${suffix}`,
  ]);
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
