#!/usr/bin/env bun
// 對真實 Bybit 歷史資料跑回測,印出目前訊號的勝率/期望值。
//
// 用法:
//   bun run backtest BTCUSDT 1h            # 預設 futures、1000 根
//   bun run backtest ETHUSDT 4h 2000       # 指定根數
//   bun run backtest BTCUSDT 1h 1000 spot  # 指定市場
//
// 注意:這是離線分析腳本,不影響 Worker 執行;純讀 Bybit 公開資料。

import { type BacktestResult, backtest } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { defaultConfig } from "../src/signal.js";
import type { Market } from "../src/types.js";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function report(title: string, r: BacktestResult): void {
  console.log(`\n=== ${title} ===`);
  console.log(`交易筆數    ${r.total}`);
  console.log(`勝率        ${pct(r.winRate)}  (${r.wins} 勝 / ${r.losses} 敗)`);
  console.log(`期望值/筆   ${r.avgR.toFixed(3)} R   ← >0 才有正期望`);
  console.log(`累積        ${r.totalR.toFixed(1)} R`);
  console.log(
    `Profit Factor ${r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)}  ← >1 才賺錢`,
  );
  console.log(`平均賺      +${r.avgWinR.toFixed(2)} R   平均賠 -${r.avgLossR.toFixed(2)} R`);
  console.log(`最大回撤    ${r.maxDrawdownR.toFixed(1)} R`);
  console.log(`平均持倉    ${r.avgBarsHeld.toFixed(1)} 根`);
}

async function main(): Promise<void> {
  const [symbol = "BTCUSDT", interval = "1h", limitArg, marketArg] = process.argv.slice(2);
  const limit = limitArg ? Number(limitArg) : 1000;
  const market = (marketArg as Market) ?? "futures";

  console.log(`抓取 ${market} ${symbol} ${interval} 最近 ${limit} 根…`);
  const klines = await fetchKlines(market, symbol, interval, limit);
  console.log(
    `實際取得 ${klines.length} 根 (${new Date(klines[0].openTime).toISOString().slice(0, 10)} ~ ${new Date(klines[klines.length - 1].openTime).toISOString().slice(0, 10)})`,
  );

  const cfg = defaultConfig();
  report("僅停損/停利出場", backtest(klines, cfg));
  report("反向訊號則反手", backtest(klines, cfg, { reverseOnSignal: true }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
