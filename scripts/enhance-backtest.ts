#!/usr/bin/env bun
// 驗證三個策略增強(支撐壓力/斜率/影線)是否在樣本外泛化。
// 方法:前 70% 訓練、後 30% 測試;baseline vs 逐一開關,比較 test 集 avgR、minPF、賺錢標的比例。
// 採用準則:test 集 avgR 不劣於 baseline 且「賺錢標的數」不減少(單一標的變好不算數)。
// 用法:bun run enhance-backtest [interval]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type Trade } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { defaultConfig } from "../src/signal.js";
import type { Config, Kline } from "../src/types.js";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];
const CACHE_DIR =
  "/private/tmp/claude-501/-Users-riversoft-Desktop-workSpace-side-project-crypto-signal-bot/f000ee31-9958-4dd7-acc2-3271c86fdc50/scratchpad/klines";

async function loadKlines(symbol: string, interval: string, maxBars: number): Promise<Kline[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = `${CACHE_DIR}/${symbol}-${interval}-${maxBars}.json`;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Kline[];
  } catch {
    process.stdout.write(`  抓 ${symbol} ${interval}…`);
    const k = await fetchKlines("futures", symbol, interval, maxBars);
    writeFileSync(path, JSON.stringify(k));
    console.log(` ${k.length} 根`);
    return k;
  }
}

function split(kl: Kline[]): { train: Kline[]; test: Kline[] } {
  const cut = Math.floor(kl.length * 0.7);
  return { train: kl.slice(0, cut), test: kl.slice(cut) };
}

interface Agg {
  total: number;
  avgR: number;
  minPF: number;
  profitable: number;
  count: number;
}

function evalConfig(data: Kline[][], cfg: Config): Agg {
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const kl of data) {
    const r = backtest(kl, cfg);
    all.push(...r.trades);
    if (r.total >= 5) {
      if (r.profitFactor < minPF) minPF = r.profitFactor;
      if (r.profitFactor > 1) profitable++;
    }
  }
  const s = summarize(all);
  return {
    total: s.total,
    avgR: s.avgR,
    minPF: minPF === Number.POSITIVE_INFINITY ? 0 : minPF,
    profitable,
    count: data.length,
  };
}

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return `n=${String(a.total).padStart(4)} avgR=${a.avgR.toFixed(3).padStart(6)} minPF=${pf.padStart(4)} 賺錢=${a.profitable}/${a.count}`;
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const maxBars = interval.endsWith("m") ? 8000 : interval === "1h" ? 12000 : 3000;
  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根)…`);
  const test: Kline[][] = [];
  for (const symbol of SYMBOLS) {
    try {
      const kl = await loadKlines(symbol, interval, maxBars);
      if (kl.length <= 500) continue;
      test.push(split(kl).test);
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  const base = defaultConfig();
  const variants: { label: string; patch: Partial<Config> }[] = [
    { label: "baseline", patch: {} },
    { label: "只影線 shadowComp", patch: { shadowComp: true } },
    { label: "只斜率 slopeFilter", patch: { slopeFilter: true } },
    { label: "只支撐壓力 srFilter", patch: { srFilter: true } },
    { label: "三者全開", patch: { shadowComp: true, slopeFilter: true, srFilter: true } },
  ];
  console.log("\n【test 集(樣本外)表現】");
  for (const v of variants) {
    console.log(`  ${v.label.padEnd(18)} ${fmt(evalConfig(test, { ...base, ...v.patch }))}`);
  }
  console.log(
    "\n判讀:某開關的 avgR 不劣於 baseline 且『賺錢標的數』不減少才採用(Task 8 據此打開預設)。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
