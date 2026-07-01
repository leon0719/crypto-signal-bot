#!/usr/bin/env bun
// 驗證三個策略增強(支撐壓力/斜率/影線)是否在樣本外泛化。
// 方法:前 70% 訓練、後 30% 測試;baseline vs 逐一開關,比較 test 集 avgR、minPF、賺錢標的比例。
// 每個變體同時報「MTF off」(原始訊號)與「MTF on」(套用大週期確認過濾,貼近 production)兩列,
// 因為 src/analyze.ts 與 scripts/optimize.ts 一律套用 MTF 過濾——只看 MTF off 會失真。
// 採用準則:MTF on 的 test 集 avgR 不劣於 baseline 且「賺錢標的數」不減少(單一標的變好不算數)。
// 用法:bun run enhance-backtest [interval]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type Trade } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { build, defaultConfig, evalAt, minBars } from "../src/signal.js";
import { type Config, Direction, type DirectionValue, type Kline } from "../src/types.js";

// 各週期對應的大週期確認(與 src/analyze.ts 的 HTF_MAP、scripts/optimize.ts 一致)。
const HTF_MAP: Record<string, string> = {
  "15m": "1h",
  "30m": "2h",
  "1h": "4h",
  "2h": "12h",
  "4h": "1d",
  "1d": "1w",
};

function barMs(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const u: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (u[unit] ?? 3_600_000);
}

// 把大週期評分嚴格對齊到 base 索引(只引用「在 base 收盤前已收盤」的大週期 K 棒,無前視)。
// 回傳 entryFilter:大週期反向則略過(非衝突過濾,與卡片的「降級觀望」邏輯一致)。
function htfEntryFilter(
  base: Kline[],
  htf: Kline[] | undefined,
  baseInterval: string,
  htfInterval: string | undefined,
  cfg: Config,
): ((dir: DirectionValue, i: number) => boolean) | undefined {
  if (!htf || !htfInterval || htf.length < minBars(cfg)) return undefined;
  const ind = build(htf, cfg);
  const baseBar = barMs(baseInterval);
  const htfBar = barMs(htfInterval);
  const score: (number | null)[] = new Array(base.length).fill(null);
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < base.length; i++) {
    const baseClose = base[i].openTime + baseBar;
    while (j < htf.length && htf[j].openTime + htfBar <= baseClose) {
      const s = evalAt(ind, j);
      if (s) last = s.score;
      j++;
    }
    score[i] = last;
  }
  return (dir, i) => {
    const s = score[i];
    if (s == null) return true; // 大週期未知 → 不擋
    return dir === Direction.Long ? s >= 0 : s <= 0; // 反向才擋
  };
}

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

interface Dataset {
  symbol: string;
  klines: Kline[]; // 測試段(後 30%)
  htf?: Kline[]; // 對齊用的大週期(完整序列,未切段)
}

// mtf=true 時,對每個標的用 htfEntryFilter 建立以時間戳對齊的大週期確認過濾器。
function evalConfig(data: Dataset[], cfg: Config, baseInterval: string, mtf: boolean): Agg {
  const htfInterval = HTF_MAP[baseInterval];
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const d of data) {
    const filter = mtf
      ? htfEntryFilter(d.klines, d.htf, baseInterval, htfInterval, cfg)
      : undefined;
    const r = backtest(d.klines, cfg, { entryFilter: filter });
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
  const htfInterval = HTF_MAP[interval];
  const htfMaxBars = htfInterval
    ? Math.ceil((maxBars * barMs(interval)) / barMs(htfInterval)) + 300
    : 0;

  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根;大週期確認=${htfInterval ?? "無"})…`);
  const test: Dataset[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const kl = await loadKlines(symbol, interval, maxBars);
      if (kl.length <= 500) continue;
      const htf = htfInterval ? await loadKlines(symbol, htfInterval, htfMaxBars) : undefined;
      // train/test 切的是 base K 線;htf 保留完整序列(對齊靠時間戳,切片不影響正確性)。
      test.push({ symbol, klines: split(kl).test, htf });
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
