#!/usr/bin/env bun
// OI 趨勢分項的「邊際貢獻」A/B 回測。
//
// 方法:基準訊號(signal.ts)不動,只在 backtest 的 entryFilter 加上 OI 條件,比較:
//   baseline      — 原樣
//   OI 不反對     — 只擋「OI 明確反向」的進場(寬鬆)
//   OI 須確認     — 進場方向必須有 OI 同向擴張背書(嚴格)
// 跨 8 標的彙總 avgR / PF / 交易數 / 賺錢標的數。
//
// K 線與 OI 皆用 Bybit v5(免 key、游標翻頁,深度達數年),同所一致。只取 OI 趨勢方向。
//
// 用法:bun run scripts/oi-backtest.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type Trade } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { alignOiToKlines, fetchOiHistory, type OiPoint, oiDirSeries } from "../src/oi.js";
import { defaultConfig } from "../src/signal.js";
import { Direction, type DirectionValue, type Kline } from "../src/types.js";

const CACHE_DIR =
  "/private/tmp/claude-501/-Users-riversoft-Desktop-workSpace-side-project-crypto-signal-bot/faffd838-f672-4512-b71a-15d789331ffd/scratchpad/oi-cache";
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// 本地快取一層,避免重跑時重打 OKX(尤其 OI 端點限流嚴)。
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const path = `${CACHE_DIR}/${key}.json`;
  if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as T);
  return load().then((v) => {
    writeFileSync(path, JSON.stringify(v));
    return v;
  });
}

// 對 429 / 暫時性錯誤做指數退避重試。
async function withRetry<T>(label: string, fn: () => Promise<T>, max = 5): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= max || !/429|5\d\d|fetch/i.test(msg)) throw e;
      console.error(`    ${label} 第 ${attempt + 1} 次失敗(${msg}),${delay}ms 後重試`);
      await sleep(delay);
      delay *= 2;
    }
  }
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

interface Frame {
  label: string;
  interval: string;
  barMs: number;
  maxBars: number;
}

const FRAMES: Frame[] = [
  { label: "4h × ~500 天", interval: "4h", barMs: 4 * 3600_000, maxBars: 3000 },
  { label: "1d × ~500 天", interval: "1d", barMs: 86_400_000, maxBars: 600 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SymData {
  symbol: string;
  klines: Kline[];
  oiDir: number[]; // 與 klines index 對齊
  oiCoverage: number; // 有 OI 資料的根數比例
}

async function loadFrame(frame: Frame): Promise<SymData[]> {
  const out: SymData[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const klines = await cached(`klbybit_${symbol}_${frame.interval}_${frame.maxBars}`, () =>
        withRetry(`${symbol} K線`, () =>
          fetchKlines("futures", symbol, frame.interval, frame.maxBars),
        ),
      );
      await sleep(300);
      const oi = await cached(`oibybit_${symbol}_${frame.interval}_${frame.maxBars}`, () =>
        withRetry(`${symbol} OI`, () => fetchOiHistory(symbol, frame.interval, frame.maxBars)),
      );
      const oiAtBar = alignOiToKlines(klines, oi as OiPoint[], frame.barMs);
      const oiDir = oiDirSeries(klines, oiAtBar);
      const covered = oiAtBar.filter((v) => !Number.isNaN(v)).length;
      out.push({ symbol, klines, oiDir, oiCoverage: covered / klines.length });
      await sleep(500); // 輕度節流,避免 Bybit 限流
    } catch (e) {
      console.error(`  ${symbol} 載入失敗:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

type FilterKind = "baseline" | "nonOpp" | "confirm" | "expand";

// 依 OI 方向序列產生 entryFilter。
function makeFilter(kind: FilterKind, oiDir: number[]) {
  if (kind === "baseline") return undefined;
  return (direction: DirectionValue, signalIndex: number): boolean => {
    const d = oiDir[signalIndex];
    const want = direction === Direction.Long ? 1 : -1;
    if (kind === "nonOpp") {
      // 只擋「OI 明確反向」;未知(NaN)或收縮(0)放行。
      if (Number.isNaN(d)) return true;
      return d === 0 || Math.sign(d) === want;
    }
    if (kind === "expand") {
      // 純 OI 擴張才進(不綁價格方向);收縮(0)擋,未知放行。
      if (Number.isNaN(d)) return true;
      return d === 1 || d === -1;
    }
    // confirm:必須有同向 OI 擴張背書;未知或收縮一律不進。
    return d === want;
  };
}

interface Agg {
  trades: number;
  winRate: number;
  avgR: number;
  totalR: number;
  pf: number;
  profitableSymbols: number;
  symbols: number;
}

function aggregate(perSymbolTrades: Trade[][]): Agg {
  const all: Trade[] = perSymbolTrades.flat();
  const r = summarize(all);
  let profitable = 0;
  for (const ts of perSymbolTrades) {
    if (ts.length === 0) continue;
    const s = summarize(ts);
    if (s.profitFactor > 1) profitable++;
  }
  return {
    trades: r.total,
    winRate: r.winRate,
    avgR: r.avgR,
    totalR: r.totalR,
    pf: r.profitFactor,
    profitableSymbols: profitable,
    symbols: perSymbolTrades.filter((t) => t.length > 0).length,
  };
}

function runVariant(data: SymData[], kind: FilterKind): Agg {
  const cfg = defaultConfig();
  const perSymbol: Trade[][] = [];
  for (const d of data) {
    const filter = makeFilter(kind, d.oiDir);
    const res = backtest(d.klines, cfg, filter ? { entryFilter: filter } : {});
    perSymbol.push(res.trades);
  }
  return aggregate(perSymbol);
}

function fmt(a: Agg): string {
  const pf = a.pf === Infinity ? "∞" : a.pf.toFixed(2);
  return [
    `交易 ${String(a.trades).padStart(4)}`,
    `勝率 ${(a.winRate * 100).toFixed(1).padStart(5)}%`,
    `avgR ${a.avgR >= 0 ? "+" : ""}${a.avgR.toFixed(3)}`,
    `總R ${a.totalR >= 0 ? "+" : ""}${a.totalR.toFixed(1).padStart(6)}`,
    `PF ${pf.padStart(5)}`,
    `賺錢標的 ${a.profitableSymbols}/${a.symbols}`,
  ].join("  ");
}

async function main(): Promise<void> {
  for (const frame of FRAMES) {
    console.log(`\n========== ${frame.label} ==========`);
    const data = await loadFrame(frame);
    if (data.length === 0) {
      console.log("  無資料,略過。");
      continue;
    }
    const cov = data.map((d) => `${d.symbol} ${(d.oiCoverage * 100).toFixed(0)}%`).join("  ");
    console.log(`OI 覆蓋率:${cov}`);
    const bars = data.reduce((s, d) => s + d.klines.length, 0);
    console.log(`標的 ${data.length}、總 K 棒 ${bars}`);
    console.log("");
    console.log(`baseline       ${fmt(runVariant(data, "baseline"))}`);
    console.log(`OI 不反對      ${fmt(runVariant(data, "nonOpp"))}`);
    console.log(`OI 擴張才進    ${fmt(runVariant(data, "expand"))}`);
    console.log(`OI 須確認      ${fmt(runVariant(data, "confirm"))}`);
  }
  console.log(
    "\n判讀:看「OI 不反對 / 須確認」相對 baseline 的 avgR 與 PF 是否提升、賺錢標的數是否不減。",
  );
  console.log("資料:K 線與 OI 皆 Bybit ~500 天(同所,只取 OI 趨勢方向)。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
