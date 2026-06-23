// 幣種模糊查詢:代號打錯時推薦相近的 OKX 幣別。

import { fetchUsdtBases } from "./okx.js";
import type { Market } from "./types.js";

// 把 BTCUSDT / BTC-USDT 之類還原成 base(BTC)。
export function toBase(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/[-_]/g, "")
    .replace(/(USDT|USDC|USD)$/, "");
}

// Levenshtein 編輯距離。
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// 依相似度給分(越小越相似)。99 以上視為不相關,會被濾掉。
function rank(query: string, base: string): number {
  if (base === query) return 0;
  if (base.startsWith(query)) return 1 + (base.length - query.length) / 100; // 前綴
  if (query.startsWith(base)) return 1.5 + (query.length - base.length) / 100; // 使用者多打字(DOGEE→DOGE)
  if (base.includes(query)) return 2 + base.indexOf(query) / 100; // 包含
  // 編輯距離:僅在「同首字母」時才採信,否則對短代號會出現一堆無關結果。
  if (base[0] === query[0]) return 3 + editDistance(query, base);
  return 99;
}

// 回傳最多 max 個相近的 base 幣種。抓清單失敗時回 []。
export async function suggestSymbols(
  market: Market,
  rawSymbol: string,
  max = 5,
): Promise<string[]> {
  const query = toBase(rawSymbol);
  if (!query) return [];
  let bases: string[];
  try {
    bases = await fetchUsdtBases(market);
  } catch {
    return [];
  }
  // 編輯距離容忍度:查詢越長允許差越多。
  const maxDist = Math.max(2, Math.ceil(query.length / 2));
  return (
    bases
      .map((b) => ({ b, score: rank(query, b) }))
      // 保留:前綴/包含(score<3),或同首字母且編輯距離在容忍範圍內(score<99)。
      .filter((x) => x.score < 3 || (x.score < 99 && x.score - 3 <= maxDist))
      .sort((a, b) => a.score - b.score)
      .slice(0, max)
      .map((x) => x.b)
  );
}
