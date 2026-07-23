#!/usr/bin/env bun

// 比較「SNR 支撐壓力進場」與現有評分策略在樣本外、含成本條件下的期望值。
//
// 三列對照(baseline / A 反轉 / B 突破),每列再分 MTF off / MTF on。
// 三者的出場完全相同(1×ATR 初始停損 + 2×ATR 移動停損),唯一變因是進場訊號來源——
// 進場與出場同時更換的話,測出的差異無法歸因。
//
// 採用門檻(見 docs/superpowers/specs/2026-07-23-snr-strategy-backtest-design.md):
// MTF on 的淨 avgR > baseline 淨 avgR、賺錢標的數 ≥ baseline、n ≥ 100,三者須同時成立。
//
// 用法:bun run snr-backtest [interval](預設 4h)

import type { BacktestOptions } from "../src/backtest.js";
import { type Agg, evalConfig, loadTestSets } from "../src/backtest-harness.js";
import { defaultConfig } from "../src/signal.js";
import { defaultSnrConfig, evalSnrAt } from "../src/snr.js";

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return (
    `n=${String(a.total).padStart(4)}` +
    ` avgR=${a.avgR.toFixed(3).padStart(6)}` +
    ` 淨avgR=${a.netAvgR.toFixed(3).padStart(6)}` +
    ` minPF=${pf.padStart(4)}` +
    ` 賺錢=${a.profitable}/${a.count}`
  );
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const test = await loadTestSets(interval);
  const cfg = defaultConfig();
  const snrCfg = defaultSnrConfig();

  // 出場條件三列共用,確保唯一變因是進場。
  const exit: BacktestOptions = { exit: "trailing", trailATR: 2 };
  const variants: { label: string; opts: BacktestOptions }[] = [
    { label: "baseline(現有評分策略)", opts: exit },
    {
      label: "SNR-A 反轉",
      opts: { ...exit, signal: (ind, i) => evalSnrAt(ind, i, snrCfg, "reversal") },
    },
    {
      label: "SNR-B 突破",
      opts: { ...exit, signal: (ind, i) => evalSnrAt(ind, i, snrCfg, "breakout") },
    },
  ];

  console.log(`\n【${interval} test 集(樣本外、後 30%)—— 出場統一為 1×ATR 停損 + 2×ATR 移動停損】`);
  for (const v of variants) {
    console.log(`  ${v.label}`);
    console.log(`    MTF off  ${fmt(evalConfig(test, cfg, interval, false, v.opts))}`);
    console.log(`    MTF on   ${fmt(evalConfig(test, cfg, interval, true, v.opts))}`);
  }
  console.log(
    "\n判讀:以 MTF on 的『淨avgR』為準。SNR 需同時滿足 淨avgR > baseline、賺錢標的數 ≥ baseline、n ≥ 100 才採用;" +
      "未達標則記錄為否定結論,不進 STRATEGIES、不進紙上交易。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
