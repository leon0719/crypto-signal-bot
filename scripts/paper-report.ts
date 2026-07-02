// 紙上交易週報:讀帳 → 未結部位以現價評估 → 組成績單並推 Slack。
// 用法:bun scripts/paper-report.ts [--dry]  (--dry 只印不推)
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

const PAPER_PATH = process.env.PAPER_LEDGER_PATH ?? "./data/paper-ledger.json";
const PAPER_START = Number(process.env.PAPER_START_EQUITY ?? 2000);
const dry = process.argv.includes("--dry");

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
const text = buildScorecard(summary, opens, period);

console.log(text);
if (!dry) {
  try {
    await postMessage(text);
    console.log("\n已推播成績單到 Slack。");
  } catch (e) {
    console.error(`推播失敗:${(e as Error).message}`);
    process.exitCode = 1;
  }
}
