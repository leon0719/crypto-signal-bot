// 偵測純邏輯:把掃描列篩成可進場機會、算停損停利、與上輪狀態做去重 diff。
import type { ScanRow } from "./scan.js";
import type { Regime } from "./types.js";

export interface Opportunity {
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  score: number;
  regime: Regime;
  adx: number;
  htf1d: number | null;
  oi: number | null;
}

// 四捨五入到 2 位(價格單位一致,避免浮點雜訊)。
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 停損停利:2×ATR 停損、3×ATR 目標,方向決定加減。
export function computeLevels(
  dir: "LONG" | "SHORT",
  price: number,
  atr: number,
): { stop: number; target: number } {
  return dir === "SHORT"
    ? { stop: round2(price + 2 * atr), target: round2(price - 3 * atr) }
    : { stop: round2(price - 2 * atr), target: round2(price + 3 * atr) };
}

// 只保留有效方向(通過三重確認)的列,轉成含進出場位的機會。
export function filterOpportunities(rows: ScanRow[]): Opportunity[] {
  const opps: Opportunity[] = [];
  for (const r of rows) {
    if (r.effective !== "LONG" && r.effective !== "SHORT") continue;
    const dir = r.effective;
    const { stop, target } = computeLevels(dir, r.price, r.atr);
    opps.push({
      symbol: r.symbol,
      dir,
      entry: r.price,
      stop,
      target,
      score: r.score,
      regime: r.regime,
      adx: r.adx,
      htf1d: r.htf1d,
      oi: r.oi,
    });
  }
  return opps;
}

export function keyOf(o: Opportunity): string {
  return `${o.symbol}:${o.dir}`;
}

// 與上輪 active 比對:news = 本輪新出現的;active = 本輪全部 key(消失者自動移除)。
export function diffNewOpportunities(
  opps: Opportunity[],
  prevActive: string[],
): { news: Opportunity[]; active: string[] } {
  const prev = new Set(prevActive);
  const news = opps.filter((o) => !prev.has(keyOf(o)));
  const active = opps.map(keyOf);
  return { news, active };
}
