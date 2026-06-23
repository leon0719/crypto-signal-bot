// 串接:解析指令 → 抓 OKX K 線 → 算指標評分 → 產生回覆文字。

import { helpText, parseCommand } from "./command.js";
import { buildReply } from "./format.js";
import { fetchFunding, fetchKlines } from "./okx.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";

export async function handleText(text) {
  const cmd = parseCommand(text);
  if (cmd.help) return helpText();

  const cfg = defaultConfig();
  let klines;
  try {
    klines = await fetchKlines(cmd.market, cmd.symbol, cmd.interval, 300);
  } catch (err) {
    return `❌ ${cmd.symbol} 抓取失敗:${err.message}\n請確認代號是否正確,或輸入 help 看用法。`;
  }

  const need = minBars(cfg);
  if (klines.length < need) {
    return `❌ ${cmd.symbol} 只取得 ${klines.length} 根 K 線,指標至少需要 ${need} 根。\n可能是新上市/代號有誤,或改用較小週期(如 5m)。`;
  }

  const ind = build(klines, cfg);
  const res = evalAt(ind, ind.klines.length - 1);
  if (!res) return `❌ ${cmd.symbol} 資料不足以計算指標,請改用較小週期。`;

  let funding = null;
  if (cmd.market === "futures") {
    funding = await fetchFunding(cmd.symbol);
  }

  return buildReply(cmd, ind, res, funding);
}
