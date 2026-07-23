// 離線回測腳本共用骨架:歷史資料載入/快取、train/test 切段、大週期(MTF)對齊過濾、
// 多標的彙總。scripts/enhance-backtest.ts 與 scripts/snr-backtest.ts 共用,
// 確保兩者的評估條件完全一致(否則數字無法互相比較)。
// 純離線分析,不被 Worker 匯入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type BacktestOptions, backtest, netAvgR, summarize, type Trade } from "./backtest.js";
import { fetchKlines } from "./bybit.js";
import { build, evalAt, minBars } from "./signal.js";
import { type Config, Direction, type DirectionValue, type Kline } from "./types.js";

// 各週期對應的大週期確認(與 src/analyze.ts 的 HTF_MAP、scripts/optimize.ts 一致)。
export const HTF_MAP: Record<string, string> = {
  "15m": "1h",
  "30m": "2h",
  "1h": "4h",
  "2h": "12h",
  "4h": "1d",
  "1d": "1w",
};

export const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];

const CACHE_DIR = "./.cache/klines";

export function barMs(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const u: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (u[unit] ?? 3_600_000);
}

export async function loadKlines(
  symbol: string,
  interval: string,
  maxBars: number,
): Promise<Kline[]> {
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

export function split(kl: Kline[]): { train: Kline[]; test: Kline[] } {
  const cut = Math.floor(kl.length * 0.7);
  return { train: kl.slice(0, cut), test: kl.slice(cut) };
}

// 把大週期評分嚴格對齊到 base 索引(只引用「在 base 收盤前已收盤」的大週期 K 棒,無前視)。
// 回傳 entryFilter:大週期反向則略過(非衝突過濾,與卡片的「降級觀望」邏輯一致)。
export function htfEntryFilter(
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

export interface Dataset {
  symbol: string;
  klines: Kline[]; // 測試段(後 30%)
  htf?: Kline[]; // 對齊用的大週期(完整序列,未切段)
}

export interface Agg {
  total: number;
  avgR: number;
  netAvgR: number; // 扣除 round-trip 成本後的每筆期望值
  minPF: number;
  profitable: number;
  count: number;
}

// mtf=true 時,對每個標的用 htfEntryFilter 建立以時間戳對齊的大週期確認過濾器。
// extra 用來傳出場模式或替換進場訊號(signal),各變體間必須一致才能比較。
export function evalConfig(
  data: Dataset[],
  cfg: Config,
  baseInterval: string,
  mtf: boolean,
  extra: BacktestOptions = {},
): Agg {
  const htfInterval = HTF_MAP[baseInterval];
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const d of data) {
    const filter = mtf
      ? htfEntryFilter(d.klines, d.htf, baseInterval, htfInterval, cfg)
      : undefined;
    // mtf=false 時 filter 為 undefined,不可蓋掉呼叫端在 extra 裡帶入的 entryFilter。
    const r = backtest(d.klines, cfg, { ...extra, entryFilter: filter ?? extra.entryFilter });
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
    netAvgR: netAvgR(all),
    minPF: minPF === Number.POSITIVE_INFINITY ? 0 : minPF,
    profitable,
    count: data.length,
  };
}

// 載入 SYMBOLS 全部標的、切出樣本外 test 段。大週期保留完整序列(對齊靠時間戳)。
export async function loadTestSets(interval: string): Promise<Dataset[]> {
  const maxBars = interval.endsWith("m") ? 8000 : interval === "1h" ? 12000 : 3000;
  const htfInterval = HTF_MAP[interval];
  const htfMaxBars = htfInterval
    ? Math.ceil((maxBars * barMs(interval)) / barMs(htfInterval)) + 300
    : 0;
  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根;大週期確認=${htfInterval ?? "無"})…`);
  const out: Dataset[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const kl = await loadKlines(symbol, interval, maxBars);
      if (kl.length <= 500) continue;
      const htf = htfInterval ? await loadKlines(symbol, htfInterval, htfMaxBars) : undefined;
      out.push({ symbol, klines: split(kl).test, htf });
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

export interface Window {
  label: string; // 顯示用,如 "2022Q3"
  from: number; // 含
  to: number; // 不含(半開區間,相鄰窗不重疊不遺漏)
}

// 把 [from, to] 切成涵蓋它的完整日曆季度。走動前推(walk-forward)分段評估用:
// 參數固定不動,逐段檢查邊際優勢是否在「沒被調校過的期間」仍然存在。
export function calendarQuarters(from: number, to: number): Window[] {
  if (!(from <= to)) return [];
  const out: Window[] = [];
  const d = new Date(from);
  let y = d.getUTCFullYear();
  let q = Math.floor(d.getUTCMonth() / 3); // 0..3
  for (;;) {
    const start = Date.UTC(y, q * 3, 1);
    const ny = q === 3 ? y + 1 : y;
    const nq = q === 3 ? 0 : q + 1;
    const end = Date.UTC(ny, nq * 3, 1);
    out.push({ label: `${y}Q${q + 1}`, from: start, to: end });
    if (end > to) break;
    y = ny;
    q = nq;
  }
  return out;
}
