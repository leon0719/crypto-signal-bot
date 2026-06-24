// 串接:解析指令 → 抓 OKX K 線 → 算指標評分 → 產生 LINE 訊息陣列。

import { helpText, parseCommand } from "./command.js";
import {
  buildBubble,
  buildCarouselMessage,
  buildFlexMessage,
  suggestionQuickReply,
  symbolQuickReply,
} from "./format.js";
import { textMessage } from "./line.js";
import { fetchKlines, OkxError } from "./okx.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";
import { suggestSymbols } from "./suggest.js";
import {
  type AnalyzeCommand,
  type Config,
  Direction,
  type Flex,
  type HtfInfo,
  type LineMessage,
  type Market,
} from "./types.js";

const ANALYSIS_LIMIT = 400; // 多抓一些讓 EMA200 暖機更穩(會自動翻頁)
const MULTI_INTERVALS = ["15m", "1h", "4h"];

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
  if (cmd.multi) return handleMulti(cmd);
  return handleSingle(cmd);
}

async function handleSingle(cmd: AnalyzeCommand): Promise<LineMessage[]> {
  const cfg = defaultConfig();
  // K 線與大週期確認獨立,並行抓以省網路延遲。
  const htfInterval = HTF_MAP[cmd.interval];
  const htfPromise = htfInterval
    ? evalHtfScore(cmd.market, cmd.symbol, htfInterval, cfg)
    : Promise.resolve(null);

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

  return [buildFlexMessage(cmd, ind, res, htf)];
}

// 多週期 carousel:同一幣別,多個週期各一張卡。
// 逐一抓(非並發)以降低 OKX 限流機率。
async function handleMulti(cmd: AnalyzeCommand): Promise<LineMessage[]> {
  const cfg = defaultConfig();
  const results: BubbleResult[] = [];
  for (const iv of MULTI_INTERVALS) {
    results.push(await buildBubbleFor({ ...cmd, interval: iv, multi: false }, cfg));
  }
  const bubbles = results.map((r) => r.bubble).filter((b): b is Flex => b != null);
  if (bubbles.length > 0) return [buildCarouselMessage(cmd.symbol, bubbles)];

  // 全部失敗,分辨原因給對應訊息。
  if (results.some((r) => r.error instanceof OkxError && r.error.notFound)) {
    return [await notFoundMessage(cmd, new OkxError("51001", "not found"))];
  }
  if (results.some((r) => r.error)) {
    return [textMessage(`⚠️ ${cmd.symbol} 暫時取得失敗,請稍後再試。`, symbolQuickReply())];
  }
  // 沒有錯誤但也沒卡片 = 資料根數不足(多為新上市/流動性低)。
  return [textMessage(`⚠️ ${cmd.symbol} 歷史資料不足,無法分析(可能剛上市)。`, symbolQuickReply())];
}

interface BubbleResult {
  bubble: Flex | null;
  error?: unknown;
}

async function buildBubbleFor(cmd: AnalyzeCommand, cfg: Config): Promise<BubbleResult> {
  try {
    // carousel 用單頁(300 根)即可,降低並發避免 OKX 限流。
    const klines = await fetchKlines(cmd.market, cmd.symbol, cmd.interval, 300);
    if (klines.length < minBars(cfg)) return { bubble: null };
    const ind = build(klines, cfg);
    const res = evalAt(ind, ind.klines.length - 1);
    if (!res) return { bubble: null };
    return { bubble: buildBubble(cmd, ind, res) };
  } catch (error) {
    return { bubble: null, error };
  }
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
