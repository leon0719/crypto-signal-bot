// 紙上交易協調器:每輪掃描時 (1) 結算未結部位 (2) 用當前權益開新部位。
// 抓 K 線以參數注入,方便單測與 fail-soft。純函式,不碰檔案/網路。
import type { Opportunity } from "./detect.js";
import {
  type Bar,
  openPositions,
  type PaperConfig,
  type PaperPosition,
  type Summary,
  settlePosition,
  summarize,
} from "./paper.js";
import type { PaperLedger } from "./paper-state.js";

export interface PaperRunResult {
  ledger: PaperLedger;
  summary: Summary;
  opened: PaperPosition[];
  closed: PaperPosition[]; // 本輪新結算的部位
}

export async function runPaper(
  news: Opportunity[],
  ledger: PaperLedger,
  cfg: PaperConfig,
  fetchBars: (symbol: string) => Promise<Bar[]>,
  now: number,
): Promise<PaperRunResult> {
  // 1. 結算未結部位(每個未結 symbol 抓一次 K 線)
  const openSyms = [
    ...new Set(ledger.positions.filter((p) => p.status === "OPEN").map((p) => p.symbol)),
  ];
  const barsBySym = new Map<string, Bar[]>();
  await Promise.all(
    openSyms.map(async (s) => {
      try {
        barsBySym.set(s, await fetchBars(s));
      } catch {
        barsBySym.set(s, []); // 抓不到就當本輪無新棒,下輪再試
      }
    }),
  );
  const closed: PaperPosition[] = [];
  const settled = ledger.positions.map((p) => {
    if (p.status !== "OPEN") return p;
    const done = settlePosition(p, barsBySym.get(p.symbol) ?? [], cfg);
    if (done.status !== "OPEN") closed.push(done);
    return done;
  });

  // 2. 用「起始權益 + 已結損益」為新部位定量(讓風險隨權益複利)
  const realized = settled
    .filter((p) => p.status !== "OPEN")
    .reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const equity = ledger.startEquity + realized;
  const openKeys = new Set(settled.filter((p) => p.status === "OPEN").map((p) => p.key));
  const opened = openPositions(news, openKeys, equity, now, cfg);

  const positions = [...settled, ...opened];
  return {
    ledger: { startEquity: ledger.startEquity, positions },
    summary: summarize(positions, cfg),
    opened,
    closed,
  };
}
