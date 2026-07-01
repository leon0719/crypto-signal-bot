// 掃描核心:重用訊號引擎的共用邏輯,回結構化 ScanRow,供列印腳本與偵測器共用。
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
