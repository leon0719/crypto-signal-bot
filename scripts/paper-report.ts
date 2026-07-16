// 紙上交易成績單:讀帳 → 未結部位以現價評估 → 組成績單並推該策略的 Slack 頻道。
// 用法:bun scripts/paper-report.ts [策略名] [--dry](預設 4h;--dry 只印不推)
import { fetchLastPrice } from "../src/bybit.js";
import {
  buildScorecard,
  defaultPaperConfig,
  markToMarket,
  type OpenMark,
  summarize,
} from "../src/paper.js";
import { readLedger } from "../src/paper-state.js";
import { postMessage } from "../src/slack.js";
import { strategyByName } from "../src/strategies.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const strategy = strategyByName(args.find((a) => !a.startsWith("--")) ?? "4h");
// 環境變數覆寫只適用 4h(既有部署相容);1h 一律用策略設定路徑。
const PAPER_PATH =
  strategy.name === "4h"
    ? (process.env.PAPER_LEDGER_PATH ?? strategy.ledgerPath)
    : strategy.ledgerPath;
const PAPER_START = Number(process.env.PAPER_START_EQUITY ?? 2000);

const cfg = { ...defaultPaperConfig(), startEquity: PAPER_START };
const ledger = await readLedger(PAPER_PATH, PAPER_START);

// 未結部位以現價評估浮動損益(取不到價就跳過該筆)
const opens: OpenMark[] = [];
for (const p of ledger.positions.filter((x) => x.status === "OPEN")) {
  const price = await fetchLastPrice("futures", p.symbol);
  if (price == null) continue;
  opens.push({
    symbol: p.symbol,
    dir: p.dir,
    entry: p.entry,
    price,
    unrealized: markToMarket(p, price, cfg),
  });
}

const summary = summarize(ledger.positions, cfg);
const period = `截至 ${new Date().toISOString().slice(0, 10)}`;
const text = buildScorecard(summary, opens, period, {
  strategyLabel: strategy.name,
  baseline: strategy.baseline,
});

console.log(text);
if (!dry) {
  try {
    const channel = process.env[strategy.channelEnv];
    if (!channel) throw new Error(`缺少 ${strategy.channelEnv} 環境變數`);
    await postMessage(text, channel);
    console.log(`\n已推播 ${strategy.name} 成績單到 Slack。`);
  } catch (e) {
    console.error(`推播失敗:${(e as Error).message}`);
    process.exitCode = 1;
  }
}
