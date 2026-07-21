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

// 依價格量級決定小數位:次美元幣用 5 位,其餘 2 位(與 scan-market 的 atr 格式一致)。
function roundToPrice(n: number, price: number): number {
  const digits = Math.abs(price) < 1 ? 5 : 2;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// 停損停利:2×ATR 停損、3×ATR 目標,方向決定加減,精度隨價格量級。
export function computeLevels(
  dir: "LONG" | "SHORT",
  price: number,
  atr: number,
): { stop: number; target: number } {
  const r = (n: number) => roundToPrice(n, price);
  return dir === "SHORT"
    ? { stop: r(price + 2 * atr), target: r(price - 3 * atr) }
    : { stop: r(price - 2 * atr), target: r(price + 3 * atr) };
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

export interface GuardResult {
  kept: Opportunity[];
  dropped: Opportunity[];
  notes: string[]; // 人可讀的攔截說明(推播/console 用)
}

// 相關性護欄:同輪同方向 ≥batchCollapse 支視為同一注(高相關)只留 |score| 最強一支;
// 加上「同方向同時持倉上限 maxSameDir」——擋 2026-07 前向測試裡整批空單一起停損的出血模式。
export function guardOpportunities(
  news: Opportunity[],
  openByDir: { LONG: number; SHORT: number },
  opts: { batchCollapse?: number; maxSameDir?: number } = {},
): GuardResult {
  const batchCollapse = opts.batchCollapse ?? 3;
  const maxSameDir = opts.maxSameDir ?? 3;
  const kept: Opportunity[] = [];
  const dropped: Opportunity[] = [];
  const notes: string[] = [];
  for (const dir of ["LONG", "SHORT"] as const) {
    let group = news
      .filter((o) => o.dir === dir)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    if (group.length === 0) continue;
    if (group.length >= batchCollapse) {
      notes.push(`同輪 ${group.length} 支 ${dir} 高相關,只留最強 ${group[0].symbol}`);
      dropped.push(...group.slice(1));
      group = group.slice(0, 1);
    }
    const slots = Math.max(0, maxSameDir - openByDir[dir]);
    if (group.length > slots) {
      notes.push(
        `${dir} 已持 ${openByDir[dir]} 筆達上限 ${maxSameDir},擋下 ${group
          .slice(slots)
          .map((o) => o.symbol)
          .join("、")}`,
      );
      dropped.push(...group.slice(slots));
      group = group.slice(0, slots);
    }
    kept.push(...group);
  }
  return { kept, dropped, notes };
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
