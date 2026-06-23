// 把分析結果格式化成 LINE Flex 圖卡 + quick reply。

import { Direction } from "./signal.js";

const COLOR = {
  long: "#16a34a",
  short: "#dc2626",
  neutral: "#d97706",
  sub: "#8c8c8c",
  text: "#333333",
};

function fmtNum(v) {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function dirColor(dir) {
  if (dir === Direction.Long) return COLOR.long;
  if (dir === Direction.Short) return COLOR.short;
  return COLOR.neutral;
}

function dirLabel(dir) {
  if (dir === Direction.Long) return "做多 ▲";
  if (dir === Direction.Short) return "做空 ▼";
  return "觀望 ―";
}

function conviction(score) {
  const a = Math.abs(score);
  if (a >= 60) return "強烈";
  if (a >= 25) return "中等";
  return "分歧";
}

// 兩欄一列(左標題、右內容),右側可上色。
function kvRow(label, value, color = COLOR.text, weight = "regular") {
  return {
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: label, size: "sm", color: COLOR.sub, flex: 2 },
      { type: "text", text: value, size: "sm", color, weight, flex: 5, align: "end" },
    ],
  };
}

function separator() {
  return { type: "separator", margin: "md" };
}

// meta: { symbol, interval, market, leverage }
export function buildFlexMessage(meta, ind, res, funding) {
  const cfg = ind.cfg;
  const marketZh = meta.market === "spot" ? "現貨" : "合約";
  const accent = dirColor(res.direction);

  const body = [];

  // 價格(大字)。
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

  // 訊號 + 評分。
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
  body.push(kvRow("信心", conviction(res.score), COLOR.text));
  body.push(kvRow("市場狀態", `${res.regime}｜ADX ${res.adx.toFixed(0)}`));
  if (funding != null) {
    body.push(kvRow("資金費率", `${(funding * 100).toFixed(4)}% / 8h`));
  }

  // 指標分項(▲▼ 摘要)。
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

  // 進出場規劃。
  body.push(separator());
  if (res.direction === Direction.Neutral) {
    body.push({
      type: "text",
      text: "📌 多空分歧,建議觀望,等評分明確再進場。",
      size: "sm",
      color: COLOR.text,
      wrap: true,
      margin: "md",
    });
  } else {
    const isLong = res.direction === Direction.Long;
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
      body.push(...leverageRows(meta.leverage, isLong, px, lossPct, winPct));
    }
  }

  const bubble = {
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

  const altText = `${meta.symbol} ${dirLabel(res.direction)} 評分${res.score.toFixed(0)} 價${fmtNum(res.price)}`;
  return {
    type: "flex",
    altText: altText.slice(0, 400),
    contents: bubble,
    quickReply: intervalQuickReply(meta),
  };
}

function leverageRows(lev, isLong, px, lossPct, winPct) {
  const marginLoss = lossPct * lev;
  const marginGain = winPct * lev;
  const liqDist = 100 / lev;
  const liqPrice = isLong ? px * (1 - 1 / lev) : px * (1 + 1 / lev);
  const rows = [
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

// 把目前的市場/槓桿帶進 quick reply,點按鈕只換週期。
function intervalQuickReply(meta) {
  const suffix = `${meta.market === "spot" ? " spot" : ""}${meta.leverage > 1 ? ` ${meta.leverage}x` : ""}`;
  const intervals = ["5m", "15m", "1h", "4h", "1d"];
  return {
    items: intervals.map((iv) => ({
      type: "action",
      action: { type: "message", label: iv, text: `${meta.symbol} ${iv}${suffix}` },
    })),
  };
}

// 由模糊查詢結果建立 quick reply(點按鈕直接查該幣,沿用原本市場別)。
export function suggestionQuickReply(bases, market) {
  const suffix = market === "spot" ? " spot" : "";
  return {
    items: bases.slice(0, 13).map((b) => ({
      type: "action",
      action: { type: "message", label: b.slice(0, 20), text: `${b}${suffix}` },
    })),
  };
}

// 給 help / 錯誤訊息用的常用幣別按鈕。
export function symbolQuickReply() {
  const coins = ["BTC", "ETH", "SOL", "BNB", "XRP"];
  return {
    items: coins.map((c) => ({
      type: "action",
      action: { type: "message", label: c, text: c },
    })),
  };
}
