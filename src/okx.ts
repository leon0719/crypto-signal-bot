// OKX 資料源(K 線 + 資金費率 + 可用幣種)。Worker 環境用全域 fetch。

import type { Kline, Market } from "./types.js";

const CANDLES_URL = "https://www.okx.com/api/v5/market/candles";
const TICKER_URL = "https://www.okx.com/api/v5/market/ticker";
const INSTRUMENTS_URL = "https://www.okx.com/api/v5/public/instruments";
const MAX_CANDLES = 300; // OKX 單次上限,超過要翻頁

interface OkxResponse<T = unknown> {
  code: string;
  msg: string;
  data: T;
}

// 帶型別的 OKX 錯誤;notFound 對應「交易對不存在」(code 51001),供上層判斷是否做模糊推薦。
export class OkxError extends Error {
  code: string;
  notFound: boolean;
  constructor(code: string, msg: string) {
    super(`OKX 錯誤 ${code}: ${msg}`);
    this.name = "OkxError";
    this.code = code;
    this.notFound = code === "51001";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRY = 2; // 暫時性錯誤最多重試次數(遞增退避)

// 統一的 OKX GET;對暫時性錯誤(網路、429、5xx)重試,避免並發爆量時偶發失敗。
// 注意:OKX 的業務錯誤(code !== "0",例如 51001 代號不存在)不重試,直接拋 OkxError。
async function okxGet<T = unknown>(url: string, attempt = 0): Promise<OkxResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (attempt < MAX_RETRY) {
      await sleep(300 * (attempt + 1));
      return okxGet<T>(url, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRY) {
      await sleep(300 * (attempt + 1));
      return okxGet<T>(url, attempt + 1);
    }
    throw new Error(`OKX 回應 ${res.status}`);
  }
  const body = (await res.json()) as OkxResponse<T>;
  if (body.code !== "0") throw new OkxError(body.code, body.msg);
  return body;
}

// market: "spot" | "futures";symbol 例如 BTCUSDT。
export function instId(market: Market, symbol: string): string {
  const s = symbol.toUpperCase();
  let base = "";
  let quote = "";
  for (const q of ["USDT", "USDC", "USD"]) {
    if (s.endsWith(q)) {
      base = s.slice(0, -q.length);
      quote = q;
      break;
    }
  }
  if (!base || !quote) throw new Error(`無法解析交易對 ${symbol}(支援 USDT/USDC/USD 計價)`);
  let inst = `${base}-${quote}`;
  if (market === "futures") inst += "-SWAP";
  return inst;
}

// 1h/4h/1d → 1H/4H/1D;分鐘維持小寫。
export function okxBar(interval: string): string {
  if (!interval) return "1H";
  const unit = interval[interval.length - 1];
  return unit === "m" ? interval : interval.toUpperCase();
}

// 抓 K 線,需要超過單次上限時自動以 after 往回翻頁。回傳由舊到新。
export async function fetchKlines(
  market: Market,
  symbol: string,
  interval: string,
  limit = MAX_CANDLES,
): Promise<Kline[]> {
  const inst = instId(market, symbol);
  const bar = okxBar(interval);
  const collected: Kline[] = []; // 由新到舊累積
  let after: string | undefined;
  // OKX 最新一根可能尚未收盤(confirm="0"),量能/指標會失真;丟棄它,只用已收盤 K 棒(與回測一致)。
  let dropNewestUnconfirmed = false;

  while (collected.length < limit) {
    const batch = Math.min(MAX_CANDLES, limit - collected.length);
    let url = `${CANDLES_URL}?instId=${encodeURIComponent(inst)}&bar=${bar}&limit=${batch}`;
    if (after) url += `&after=${after}`;
    const body = await okxGet<string[][]>(url);
    const rows = body.data || [];
    if (rows.length === 0) break;
    if (after === undefined) dropNewestUnconfirmed = rows[0]?.[8] === "0"; // 僅看第一批最新一根
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
    after = rows[rows.length - 1][0]; // 本批最舊一根,下批取更早
  }

  if (dropNewestUnconfirmed) collected.shift(); // collected[0] 為全域最新一根

  return collected.reverse(); // 由舊到新
}

// 即時最新成交價(訊號用已收盤棒,但卡片顯示即時價)。失敗回 null,由上層退回收盤價。
export async function fetchLastPrice(market: Market, symbol: string): Promise<number | null> {
  try {
    const inst = instId(market, symbol);
    const body = await okxGet<Array<{ last: string }>>(
      `${TICKER_URL}?instId=${encodeURIComponent(inst)}`,
    );
    const last = body.data?.[0]?.last;
    const px = last ? Number(last) : Number.NaN;
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

// 回傳指定市場所有「USDT 計價」的 base 幣種(大寫),例如 ["BTC","ETH",...]。
export async function fetchUsdtBases(market: Market, now = Date.now()): Promise<string[]> {
  const instType = market === "spot" ? "SPOT" : "SWAP";
  const cached = _basesCache.get(instType);
  if (cached && now - cached.ts < BASES_TTL_MS) return cached.bases;

  const body = await okxGet<Array<{ instId?: string; baseCcy?: string; quoteCcy?: string }>>(
    `${INSTRUMENTS_URL}?instType=${instType}`,
  );

  const set = new Set<string>();
  for (const it of body.data || []) {
    if (instType === "SPOT") {
      if (it.quoteCcy === "USDT" && it.baseCcy) set.add(it.baseCcy.toUpperCase());
    } else if (typeof it.instId === "string" && it.instId.endsWith("-USDT-SWAP")) {
      set.add(it.instId.split("-")[0].toUpperCase());
    }
  }
  const bases = [...set];
  _basesCache.set(instType, { bases, ts: now });
  return bases;
}
