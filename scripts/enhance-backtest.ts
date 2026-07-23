#!/usr/bin/env bun
// 驗證三個策略增強(支撐壓力/斜率/影線)是否在樣本外泛化。
// 方法:前 70% 訓練、後 30% 測試;baseline vs 逐一開關,比較 test 集 avgR、minPF、賺錢標的比例。
// 每個變體同時報「MTF off」(原始訊號)與「MTF on」(套用大週期確認過濾,貼近 production)兩列,
// 因為 src/analyze.ts 與 scripts/optimize.ts 一律套用 MTF 過濾——只看 MTF off 會失真。
// 採用準則:MTF on 的 test 集 avgR 不劣於 baseline 且「賺錢標的數」不減少(單一標的變好不算數)。
// 資料載入/切段/MTF 對齊的共用骨架在 src/backtest-harness.ts。
// 用法:bun run enhance-backtest [interval]

import { type Agg, evalConfig, loadTestSets } from "../src/backtest-harness.js";
import { defaultConfig } from "../src/signal.js";
import type { Config } from "../src/types.js";

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return `n=${String(a.total).padStart(4)} avgR=${a.avgR.toFixed(3).padStart(6)} minPF=${pf.padStart(4)} 賺錢=${a.profitable}/${a.count}`;
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const test = await loadTestSets(interval);
  const base = defaultConfig();
  const variants: { label: string; patch: Partial<Config> }[] = [
    { label: "baseline", patch: {} },
    { label: "只影線 shadowComp", patch: { shadowComp: true } },
    { label: "只斜率 slopeFilter", patch: { slopeFilter: true } },
    { label: "只支撐壓力 srFilter", patch: { srFilter: true } },
    { label: "三者全開", patch: { shadowComp: true, slopeFilter: true, srFilter: true } },
  ];
  console.log("\n【test 集(樣本外)表現 —— 每個變體對照 MTF off / MTF on】");
  for (const v of variants) {
    const cfg = { ...base, ...v.patch };
    console.log(`  ${v.label}`);
    console.log(`    MTF off  ${fmt(evalConfig(test, cfg, interval, false))}`);
    console.log(`    MTF on   ${fmt(evalConfig(test, cfg, interval, true))}`);
  }
  console.log(
    "\n判讀:以 MTF on(貼近 production 訊號)為準——某開關的 avgR 不劣於 baseline 且『賺錢標的數』不減少才採用(Task 8 據此打開預設)。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
