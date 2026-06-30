#!/usr/bin/env bun
// 參數掃描:把 entryThreshold 從 15 掃到 45,跨多個標的彙總回測,看期望值曲線。
//
// 用法:
//   bun run sweep                 # 預設一籃子幣 × 1h
//   bun run sweep 4h              # 指定週期
//   bun run sweep 1h 1500         # 週期 + 根數
//
// 多標的彙總可降低「單一幣過擬合」的風險:把所有交易合併後再算整體統計。

import { backtest, summarize, type Trade } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { defaultConfig } from "../src/signal.js";
import type { Kline } from "../src/types.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const THRESHOLDS = [15, 20, 25, 30, 35, 40, 45];

async function main(): Promise<void> {
  const [interval = "1h", limitArg] = process.argv.slice(2);
  const limit = limitArg ? Number(limitArg) : 1500;

  // 先把各標的的 K 線抓好,後面對不同門檻重複使用(只抓一次)。
  const data: { symbol: string; klines: Kline[] }[] = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`抓取 ${symbol} ${interval}…`);
    try {
      const klines = await fetchKlines("futures", symbol, interval, limit);
      data.push({ symbol, klines });
      console.log(` ${klines.length} 根`);
    } catch (e) {
      console.log(` 失敗(略過): ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n標的:${data.map((d) => d.symbol).join(", ")}  週期:${interval}`);
  console.log("\n門檻  交易數   勝率    期望值/筆   累積R   PF");
  console.log("────────────────────────────────────────────────");

  for (const th of THRESHOLDS) {
    const allTrades: Trade[] = [];
    for (const { klines } of data) {
      const cfg = { ...defaultConfig(), entryThreshold: th };
      allTrades.push(...backtest(klines, cfg).trades);
    }
    const r = summarize(allTrades);
    const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
    console.log(
      `${String(th).padStart(3)}   ${String(r.total).padStart(5)}   ` +
        `${(r.winRate * 100).toFixed(1).padStart(5)}%  ` +
        `${r.avgR.toFixed(3).padStart(8)} R  ${r.totalR.toFixed(1).padStart(6)}  ${pf}`,
    );
  }
  console.log("\n挑「期望值/筆」最高且交易數仍足夠(統計顯著)的門檻。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
