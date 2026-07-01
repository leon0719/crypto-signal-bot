// 掃描核心:重用訊號引擎的共用邏輯,回結構化 ScanRow,供列印腳本與偵測器共用。
import { fetchKlines, fetchLastPrice } from "./bybit.js";
import { evalOiDir } from "./oi.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";
import type { DirectionValue, Regime, Result } from "./types.js";
import { Direction } from "./types.js";

export interface ScanRow {
  symbol: string;
  dir: DirectionValue; // 引擎原始方向
  effective: DirectionValue | "DOWNGRADED"; // 套用衝突降級後的有效方向
  score: number;
  regime: Regime;
  adx: number;
  htf1d: number | null;
  oi: number | null; // -1 | 0 | 1
  price: number; // 即時價;取不到退回收盤價
  atr: number;
  htfConflict: boolean;
  oiConflict: boolean;
}

// 純函式:由引擎輸出組出一列掃描結果(與 scan-market 的衝突降級規則一致)。
export function buildScanRow(
  symbol: string,
  res: Result,
  htf: number | null,
  oi: number | null,
  live: number | null,
): ScanRow {
  const dir = res.direction;
  const htfConflict =
    htf != null && ((dir === Direction.Long && htf < 0) || (dir === Direction.Short && htf > 0));
  const oiConflict =
    oi != null && ((dir === Direction.Long && oi < 0) || (dir === Direction.Short && oi > 0));
  const effective = dir !== Direction.Neutral && (htfConflict || oiConflict) ? "DOWNGRADED" : dir;
  return {
    symbol,
    dir,
    effective,
    score: res.score,
    regime: res.regime,
    adx: res.adx,
    htf1d: htf,
    oi,
    price: live ?? res.price,
    atr: res.atr,
    htfConflict,
    oiConflict,
  };
}

export const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "TONUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "NEARUSDT",
  "APTUSDT",
];
export const INTERVAL = "4h";
export const HTF = "1d";

const cfg = defaultConfig();

async function htfScore(sym: string): Promise<number | null> {
  try {
    const k = await fetchKlines("futures", sym, HTF, 400);
    if (k.length < minBars(cfg)) return null;
    return evalAt(build(k, cfg), k.length - 1)?.score ?? null;
  } catch {
    return null;
  }
}

// 掃描全部 SYMBOLS,回結構化列。單幣失敗 fail-soft 跳過(不進結果)。
export async function runScan(): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const sym of SYMBOLS) {
    try {
      const klines = await fetchKlines("futures", sym, INTERVAL, 400);
      const ind = build(klines, cfg);
      const res = evalAt(ind, ind.klines.length - 2); // 最後一根已收盤 K 棒
      if (!res) continue;
      const [htf, oi, live] = await Promise.all([
        htfScore(sym),
        evalOiDir(sym, INTERVAL, ind.klines),
        fetchLastPrice("futures", sym),
      ]);
      rows.push(buildScanRow(sym, res, htf, oi, live));
    } catch (e) {
      // fail-soft:單幣錯誤跳過,但記錄以利排障
      console.warn(`掃描 ${sym} 失敗:${(e as Error).message}`);
    }
  }
  return rows;
}
