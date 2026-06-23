// OKX 資料源(K 線 + 資金費率)。Worker 環境用全域 fetch。

const CANDLES_URL = "https://www.okx.com/api/v5/market/candles";
const FUNDING_URL = "https://www.okx.com/api/v5/public/funding-rate";
const MAX_CANDLES = 300; // OKX 單次上限

// 帶型別的 OKX 錯誤;notFound 對應「交易對不存在」(code 51001),供上層判斷是否做模糊推薦。
export class OkxError extends Error {
  constructor(code, msg) {
    super(`OKX 錯誤 ${code}: ${msg}`);
    this.name = "OkxError";
    this.code = code;
    this.notFound = code === "51001";
  }
}

// 統一的 OKX GET + 錯誤處理。
async function okxGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX 回應 ${res.status}`);
  const body = await res.json();
  if (body.code !== "0") throw new OkxError(body.code, body.msg);
  return body;
}

// market: "spot" | "futures";symbol 例如 BTCUSDT。
export function instId(market, symbol) {
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
export function okxBar(interval) {
  if (!interval) return "1H";
  const unit = interval[interval.length - 1];
  return unit === "m" ? interval : interval.toUpperCase();
}

export async function fetchKlines(market, symbol, interval, limit = MAX_CANDLES) {
  const inst = instId(market, symbol);
  const bar = okxBar(interval);
  const url = `${CANDLES_URL}?instId=${encodeURIComponent(inst)}&bar=${bar}&limit=${Math.min(limit, MAX_CANDLES)}`;
  const body = await okxGet(url);
  const rows = body.data || [];
  // OKX 回傳為新到舊,需反轉成舊到新。
  const klines = rows
    .map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    .reverse();
  return klines;
}

const INSTRUMENTS_URL = "https://www.okx.com/api/v5/public/instruments";

// isolate 內快取可用幣種,避免每次失敗都重抓(清單不常變)。
const _basesCache = new Map(); // instType -> { bases: string[], ts }
const BASES_TTL_MS = 10 * 60 * 1000;

// 回傳指定市場所有「USDT 計價」的 base 幣種(大寫),例如 ["BTC","ETH",...]。
export async function fetchUsdtBases(market, now = Date.now()) {
  const instType = market === "spot" ? "SPOT" : "SWAP";
  const cached = _basesCache.get(instType);
  if (cached && now - cached.ts < BASES_TTL_MS) return cached.bases;

  const body = await okxGet(`${INSTRUMENTS_URL}?instType=${instType}`);

  const set = new Set();
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

// 回傳當前資金費率(小數),失敗回 null。
export async function fetchFunding(symbol) {
  try {
    const inst = instId("futures", symbol);
    const body = await okxGet(`${FUNDING_URL}?instId=${encodeURIComponent(inst)}`);
    const rate = body?.data?.[0]?.fundingRate;
    return rate != null ? Number(rate) : null;
  } catch {
    return null;
  }
}
