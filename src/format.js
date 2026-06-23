// 把分析結果格式化成 LINE 文字訊息(用 emoji 取代終端機顏色)。

import { Direction } from "./signal.js";

function fmtNum(v) {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function dirLabel(dir) {
  if (dir === Direction.Long) return "🟢 做多(看漲)";
  if (dir === Direction.Short) return "🔴 做空(看跌)";
  return "🟡 觀望";
}

function conviction(score) {
  const a = Math.abs(score);
  if (a >= 60) return "強烈";
  if (a >= 25) return "中等";
  return "分歧";
}

// meta: { symbol, interval, market, leverage }
export function buildReply(meta, ind, res, funding) {
  const cfg = ind.cfg;
  const lines = [];
  const marketZh = meta.market === "spot" ? "現貨" : "合約";
  lines.push(`📊 ${meta.symbol}(OKX ${marketZh} · ${meta.interval})`);
  lines.push(`價格 ${fmtNum(res.price)}`);
  lines.push("");
  lines.push(`${dirLabel(res.direction)}　評分 ${res.score >= 0 ? "+" : ""}${res.score.toFixed(0)}/100(${conviction(res.score)})`);
  lines.push(`狀態 ${res.regime}｜ADX ${res.adx.toFixed(0)}`);
  if (funding != null) {
    lines.push(`資金費率 ${(funding * 100).toFixed(4)}%/8h`);
  }

  // 指標分項摘要(只列方向)。
  const comps = res.components
    .map((c) => `${c.name}${c.value > 0 ? "▲" : c.value < 0 ? "▼" : "─"}`)
    .join(" ");
  lines.push("");
  lines.push(comps);

  // 進出場規劃。
  const px = res.price;
  const atr = res.atr;
  if (res.direction === Direction.Neutral) {
    lines.push("");
    lines.push("📌 多空分歧,建議觀望,等評分明確再進場。");
  } else {
    const isLong = res.direction === Direction.Long;
    const stop = isLong ? px - cfg.stopATR * atr : px + cfg.stopATR * atr;
    const target = isLong ? px + cfg.takeATR * atr : px - cfg.takeATR * atr;
    const lossPct = (Math.abs(stop - px) / px) * 100;
    const winPct = (Math.abs(target - px) / px) * 100;
    const rr = winPct / lossPct;
    lines.push("");
    lines.push(`🎯 進場 ~${fmtNum(px)}`);
    lines.push(`🔴 停損 ${fmtNum(stop)}(-${lossPct.toFixed(1)}%)`);
    lines.push(`🟢 停利 ${fmtNum(target)}(+${winPct.toFixed(1)}%)`);
    lines.push(`賺賠比 ${rr.toFixed(1)} : 1`);

    if (meta.leverage > 1 && meta.market === "futures") {
      lines.push("");
      lines.push(...leverageLines(meta.leverage, isLong, px, lossPct, winPct));
    }
  }

  lines.push("");
  lines.push("⚠️ 指標僅供參考,非投資建議。");
  return lines.join("\n");
}

function leverageLines(lev, isLong, px, lossPct, winPct) {
  const marginLoss = lossPct * lev;
  const marginGain = winPct * lev;
  const liqDist = 100 / lev;
  const liqPrice = isLong ? px * (1 - 1 / lev) : px * (1 + 1 / lev);
  const out = [`⚡ 槓桿 ${lev}×`];
  out.push(`　保證金盈虧 +${marginGain.toFixed(0)}% / -${marginLoss.toFixed(0)}%`);
  out.push(`　強平價 ~${fmtNum(liqPrice)}(${liqDist.toFixed(1)}%,粗估)`);
  if (lossPct >= liqDist) {
    const safe = Math.floor(100 / lossPct);
    out.push(`　❗ 停損比強平還遠 → 會先被強平!建議 ≤ ${safe}×`);
  } else if (lossPct >= liqDist * 0.7) {
    out.push("　⚠️ 停損接近強平,建議降槓桿");
  } else {
    out.push("　✅ 停損在強平之前");
  }
  return out;
}
