// OKX 資料源(K 線 + 資金費率)。Worker 環境用全域 fetch。

const CANDLES_URL = "https://www.okx.com/api/v5/market/candles";
const FUNDING_URL = "https://www.okx.com/api/v5/public/funding-rate";

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

export async function fetchKlines(market, symbol, interval, limit = 300) {
  const inst = instId(market, symbol);
  const bar = okxBar(interval);
  const url = `${CANDLES_URL}?instId=${encodeURIComponent(inst)}&bar=${bar}&limit=${Math.min(limit, 300)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX 回應 ${res.status}`);
  const body = await res.json();
  if (body.code !== "0") throw new Error(`OKX 錯誤 ${body.code}: ${body.msg}`);
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

// 回傳當前資金費率(小數),失敗回 null。
export async function fetchFunding(symbol) {
  try {
    const inst = instId("futures", symbol);
    const res = await fetch(`${FUNDING_URL}?instId=${encodeURIComponent(inst)}`);
    if (!res.ok) return null;
    const body = await res.json();
    const rate = body?.data?.[0]?.fundingRate;
    return rate != null ? Number(rate) : null;
  } catch {
    return null;
  }
}
