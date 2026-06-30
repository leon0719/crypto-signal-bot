// 串接:解析指令 → 抓 OKX K 線 → 算指標評分 → 產生 LINE 訊息陣列。

import { helpText, parseCommand } from "./command.js";
import { buildFlexMessage, suggestionQuickReply, symbolQuickReply } from "./format.js";
import { textMessage } from "./line.js";
import { fetchKlines, fetchLastPrice, OkxError } from "./okx.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";
import { suggestSymbols } from "./suggest.js";
import {
  type AnalyzeCommand,
  type Config,
  Direction,
  type HtfInfo,
  type LineMessage,
  type Market,
} from "./types.js";

const ANALYSIS_LIMIT = 400; // 多抓一些讓 EMA200 暖機更穩(會自動翻頁)

// 各週期對應的「大週期」確認。
const HTF_MAP: Record<string, string> = {
  "1m": "15m",
  "3m": "30m",
  "5m": "30m",
  "15m": "1h",
  "30m": "2h",
  "1h": "4h",
  "2h": "12h",
  "4h": "1d",
  "6h": "1d",
  "12h": "1d",
  "1d": "1w",
};

// 回傳 LINE messages 陣列。
export async function handleText(text: string): Promise<LineMessage[]> {
  const cmd = parseCommand(text);
  if (cmd.help) return [textMessage(helpText(), symbolQuickReply())];
  return handleSingle(cmd);
}

async function handleSingle(cmd: AnalyzeCommand): Promise<LineMessage[]> {
  const cfg = defaultConfig();
  // K 線、大週期確認、即時價彼此獨立,並行抓以省網路延遲。
  const htfInterval = HTF_MAP[cmd.interval];
  const htfPromise = htfInterval
    ? evalHtfScore(cmd.market, cmd.symbol, htfInterval, cfg)
    : Promise.resolve(null);
  const livePromise = fetchLastPrice(cmd.market, cmd.symbol);

  let klines: Awaited<ReturnType<typeof fetchKlines>>;
  try {
    klines = await fetchKlines(cmd.market, cmd.symbol, cmd.interval, ANALYSIS_LIMIT);
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

  const htfScore = await htfPromise;
  const htf: HtfInfo | undefined =
    htfScore == null
      ? undefined
      : {
          interval: htfInterval,
          score: htfScore,
          conflict:
            (res.direction === Direction.Long && htfScore < 0) ||
            (res.direction === Direction.Short && htfScore > 0),
        };

  const livePrice = await livePromise; // 即時價;失敗回 null,卡片退回收盤價
  return [buildFlexMessage(cmd, ind, res, htf, livePrice)];
}

// 只取大週期的評分(供 MTF 確認),失敗回 null。
async function evalHtfScore(
  market: Market,
  symbol: string,
  interval: string,
  cfg: Config,
): Promise<number | null> {
  try {
    const klines = await fetchKlines(market, symbol, interval, ANALYSIS_LIMIT);
    if (klines.length < minBars(cfg)) return null;
    const ind = build(klines, cfg);
    const res = evalAt(ind, ind.klines.length - 1);
    return res ? res.score : null;
  } catch {
    return null;
  }
}

// 代號不存在時,推薦相近幣種。
async function notFoundMessage(cmd: AnalyzeCommand, err: unknown): Promise<LineMessage> {
  if (err instanceof OkxError && err.notFound) {
    const matches = await suggestSymbols(cmd.market, cmd.symbol, 5);
    if (matches.length > 0) {
      return textMessage(
        `❓ 找不到 ${cmd.symbol},你是不是要找:\n${matches.join("、")}\n\n點下方按鈕直接查詢 👇`,
        suggestionQuickReply(matches, cmd.market),
      );
    }
    return textMessage(
      `❓ 找不到 ${cmd.symbol},也沒有相近的幣種。\n請確認代號,或輸入 help。`,
      symbolQuickReply(),
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return textMessage(
    `❌ ${cmd.symbol} 抓取失敗:${msg}\n請確認代號是否正確,或輸入 help 看用法。`,
    symbolQuickReply(),
  );
}
