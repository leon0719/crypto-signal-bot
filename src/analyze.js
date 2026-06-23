// 串接:解析指令 → 抓 OKX K 線 → 算指標評分 → 產生 LINE 訊息陣列。

import { helpText, parseCommand } from "./command.js";
import { buildFlexMessage, suggestionQuickReply, symbolQuickReply } from "./format.js";
import { textMessage } from "./line.js";
import { fetchFunding, fetchKlines } from "./okx.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";
import { suggestSymbols } from "./suggest.js";

// 回傳 LINE messages 陣列。
export async function handleText(text) {
  const cmd = parseCommand(text);
  if (cmd.help) return [textMessage(helpText(), symbolQuickReply())];

  const cfg = defaultConfig();
  let klines;
  try {
    klines = await fetchKlines(cmd.market, cmd.symbol, cmd.interval, 300);
  } catch (err) {
    return [await notFoundMessage(cmd, err)];
  }

  const need = minBars(cfg);
  if (klines.length < need) {
    return [
      textMessage(
        `❌ ${cmd.symbol} 只取得 ${klines.length} 根 K 線,指標至少需要 ${need} 根。\n可能是新上市/代號有誤,或改用較小週期(如 5m)。`,
        symbolQuickReply(),
      ),
    ];
  }

  const ind = build(klines, cfg);
  const res = evalAt(ind, ind.klines.length - 1);
  if (!res) return [textMessage(`❌ ${cmd.symbol} 資料不足以計算指標,請改用較小週期。`)];

  let funding = null;
  if (cmd.market === "futures") {
    funding = await fetchFunding(cmd.symbol);
  }
  return [buildFlexMessage(cmd, ind, res, funding)];
}

// 代號不存在時,推薦相近幣種。
async function notFoundMessage(cmd, err) {
  const notExist = /51001|doesn't exist|not.*exist/i.test(err.message);
  if (notExist) {
    const matches = await suggestSymbols(cmd.market, cmd.symbol, 5);
    if (matches.length > 0) {
      return textMessage(
        `❓ 找不到 ${cmd.symbol},你是不是要找:\n${matches.join("、")}\n\n點下方按鈕直接查詢 👇`,
        suggestionQuickReply(matches, cmd.market),
      );
    }
    return textMessage(`❓ 找不到 ${cmd.symbol},也沒有相近的幣種。\n請確認代號,或輸入 help。`, symbolQuickReply());
  }
  return textMessage(
    `❌ ${cmd.symbol} 抓取失敗:${err.message}\n請確認代號是否正確,或輸入 help 看用法。`,
    symbolQuickReply(),
  );
}
