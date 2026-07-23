// SNR(支撐壓力)進場策略:只用水平位判斷方向,完全不看評分/EMA/RSI。
// 與 signal.ts 平行的獨立進場來源,供 backtest.ts 的 signal hook 使用。
//
// A 反轉(reversal):價格觸及水平位但尚未穿越 → 賭它被擋回來。
// B 突破(breakout):收盤明確穿越水平位 → 賭它續行。
//
// 兩者都用 ta.nearestSR()(fractal 轉折點,右側需 span 根確認,無前視偏差)。
// 注意:nearestSR 回傳的壓力嚴格在現價之上、支撐嚴格在現價之下,故「突破」無法
// 用當根的水平位判斷——價格站上壓力後該水平位就不再被回傳。B 模式因此改用
// 「前一根收盤時的水平位」對比「本根收盤價」,兩端皆為已收盤資料,同樣無前視。

import type { SignalHit } from "./backtest.js";
import * as ta from "./ta.js";
import { Direction, type DirectionValue, type Indicators } from "./types.js";

export type SnrMode = "reversal" | "breakout";

export interface SnrConfig {
  srSpan: number; // 轉折高低點左右確認根數
  touchATR: number; // A:視為「觸及」水平位的距離(×ATR)
  breakATR: number; // B:視為「有效突破」所需的穿越幅度(×ATR)
}

export function defaultSnrConfig(): SnrConfig {
  return { srSpan: 5, touchATR: 0.3, breakATR: 0.3 };
}

export function evalSnrAt(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  mode: SnrMode,
): SignalHit | null {
  const price = ind.close[i];
  const atr = ind.atr[i];
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return null;

  const direction =
    mode === "reversal"
      ? reversalDir(ind, i, cfg, price, atr)
      : breakoutDir(ind, i, cfg, price, atr);
  if (direction === null) return null;
  return { direction, atr, price };
}

// A:貼近支撐(且收盤仍在其上)做多、貼近壓力(且收盤仍在其下)做空。
// 收盤已穿越時,該水平位不會被 nearestSR 回傳,自然不成立——不需額外判斷。
// 上下兩側同時貼近(區間過窄)時方向不明確,回觀望。
function reversalDir(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  price: number,
  atr: number,
): DirectionValue {
  const { res, sup } = ta.nearestSR(ind.high, ind.low, i, cfg.srSpan, price);
  const band = cfg.touchATR * atr;
  const nearSup = Number.isFinite(sup) && price - sup <= band;
  const nearRes = Number.isFinite(res) && res - price <= band;
  if (nearSup && !nearRes) return Direction.Long;
  if (nearRes && !nearSup) return Direction.Short;
  return Direction.Neutral;
}

// B:以「前一根收盤時的水平位」為基準,本根收盤穿越超過 breakATR×ATR 才算有效突破。
function breakoutDir(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  price: number,
  atr: number,
): DirectionValue | null {
  if (i < 1) return null;
  const prev = ind.close[i - 1];
  if (!Number.isFinite(prev)) return null;
  const { res, sup } = ta.nearestSR(ind.high, ind.low, i - 1, cfg.srSpan, prev);
  const buf = cfg.breakATR * atr;
  if (Number.isFinite(res) && price > res + buf) return Direction.Long;
  if (Number.isFinite(sup) && price < sup - buf) return Direction.Short;
  return Direction.Neutral;
}
