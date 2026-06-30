// Bybit 資料源(K 線 + 即時價 + 可用幣種)。Worker 環境用全域 fetch。
// 全面取代先前的 OKX 資料層:K 線、即時價、合約清單都改打 Bybit v5;OI 也用 Bybit(見 oi.ts),
// 同所一致、歷史更深(K 線/OI 皆可回溯數年)。

import type { Kline, Market } from "./types.js";

const BASE = "https://api.bybit.com/v5/market";

interface BybitResponse<T = unknown> {
  retCode: number;
  retMsg: string;
  result: T;
}

// 帶型別的 Bybit 錯誤;notFound 對應「代號不存在」(retCode 10001 = params error: symbol invalid),
// 供上層判斷是否做模糊推薦。
export class BybitError extends Error {
  retCode: number;
  notFound: boolean;
  constructor(retCode: number, retMsg: string) {
    super(`Bybit 錯誤 ${retCode}: ${retMsg}`);
    this.name = "BybitError";
    this.retCode = retCode;
    this.notFound = retCode === 10001;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRY = 2; // 暫時性錯誤最多重試次數(遞增退避)

// 統一的 Bybit GET;對暫時性錯誤(網路、429、5xx)重試。
// 注意:Bybit 業務錯誤(retCode !== 0,例如 10001 代號不存在)不重試,直接拋 BybitError。
async function bybitGet<T = unknown>(url: string, attempt = 0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (attempt < MAX_RETRY) {
      await sleep(300 * (attempt + 1));
      return bybitGet<T>(url, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRY) {
      await sleep(300 * (attempt + 1));
      return bybitGet<T>(url, attempt + 1);
    }
    throw new Error(`Bybit 回應 ${res.status}`);
  }
  const body = (await res.json()) as BybitResponse<T>;
  if (body.retCode !== 0) throw new BybitError(body.retCode, body.retMsg);
  return body.result;
}

// market: "spot" | "futures" → Bybit category。
function category(market: Market): "spot" | "linear" {
  return market === "spot" ? "spot" : "linear";
}

// Bybit 的交易對直接用 BTCUSDT 形式(無連字號)。
export function bybitSymbol(symbol: string): string {
  return symbol.toUpperCase();
}

// 專案週期 → Bybit kline interval(分鐘數,或 D/W/M)。
// 注意:這跟 oi.ts 的 OI intervalTime("4h"/"1d"/"5min")格式不同,勿混用。
export function klineInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "2h": "120",
    "4h": "240",
    "6h": "360",
    "12h": "720",
    "1d": "D",
    "1w": "W",
    "1M": "M",
  };
  return map[interval] ?? interval.toUpperCase();
}

// 由週期字串估算一根的毫秒數(用來判斷最新一根是否仍在形成)。
function intervalMs(interval: string): number {
  const unit = interval[interval.length - 1];
  const n = Number(interval.slice(0, -1)) || 1;
  const ms: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * (ms[unit] ?? 0);
}

const MAX_KLINE = 1000; // Bybit 單次上限

// 抓 K 線,需要超過單次上限時自動以 end 往回翻頁。回傳由舊到新。
export async function fetchKlines(
  market: Market,
  symbol: string,
  interval: string,
  limit = 300,
): Promise<Kline[]> {
  const cat = category(market);
  const sym = bybitSymbol(symbol);
  const iv = klineInterval(interval);
  const barMs = intervalMs(interval);
  const collected: Kline[] = []; // 由新到舊累積
  let end: number | undefined;

  while (collected.length < limit) {
    const batch = Math.min(MAX_KLINE, limit - collected.length);
    let url = `${BASE}/kline?category=${cat}&symbol=${encodeURIComponent(sym)}&interval=${iv}&limit=${batch}`;
    if (end !== undefined) url += `&end=${end}`;
    const result = await bybitGet<{ list: string[][] }>(url);
    const rows = result.list || []; // 由新到舊:[start, open, high, low, close, volume, turnover]
    if (rows.length === 0) break;
    for (const r of rows) {
      collected.push({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    if (rows.length < batch) break; // 沒有更多歷史
    end = Number(rows[rows.length - 1][0]) - 1; // 本批最舊一根再往前,下批取更早
  }

  // Bybit 最新一根可能尚未收盤;若仍在形成(收盤時點還沒到)則丟棄,只用已收盤 K 棒(與回測一致)。
  if (collected.length > 0 && barMs > 0 && collected[0].openTime + barMs > Date.now()) {
    collected.shift(); // collected[0] 為全域最新一根
  }

  return collected.reverse(); // 由舊到新
}

// 即時最新成交價(訊號用已收盤棒,但卡片顯示即時價)。失敗回 null,由上層退回收盤價。
export async function fetchLastPrice(market: Market, symbol: string): Promise<number | null> {
  try {
    const result = await bybitGet<{ list: Array<{ lastPrice: string }> }>(
      `${BASE}/tickers?category=${category(market)}&symbol=${encodeURIComponent(bybitSymbol(symbol))}`,
    );
    const px = Number(result.list?.[0]?.lastPrice);
    return Number.isFinite(px) ? px : null;
  } catch {
    return null;
  }
}

// isolate 內快取可用幣種,避免每次失敗都重抓(清單不常變)。
const _basesCache = new Map<string, { bases: string[]; ts: number }>();
const BASES_TTL_MS = 10 * 60 * 1000;

// 測試用:清空幣種快取(避免跨測試汙染)。
export function clearBasesCache(): void {
  _basesCache.clear();
}

// 回傳指定市場所有「USDT 計價、交易中」的 base 幣種(大寫),例如 ["BTC","ETH",...]。
export async function fetchUsdtBases(market: Market, now = Date.now()): Promise<string[]> {
  const cat = category(market);
  const cached = _basesCache.get(cat);
  if (cached && now - cached.ts < BASES_TTL_MS) return cached.bases;

  const result = await bybitGet<{
    list: Array<{ baseCoin?: string; quoteCoin?: string; status?: string }>;
  }>(`${BASE}/instruments-info?category=${cat}&limit=1000`);

  const set = new Set<string>();
  for (const it of result.list || []) {
    if (it.quoteCoin === "USDT" && it.status === "Trading" && it.baseCoin) {
      set.add(it.baseCoin.toUpperCase());
    }
  }
  const bases = [...set];
  _basesCache.set(cat, { bases, ts: now });
  return bases;
}
