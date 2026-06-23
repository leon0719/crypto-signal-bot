// 技術指標(純 JS 移植自 Go 版 crypto-signal/internal/ta)。
// 所有函式回傳與輸入等長的陣列,資料不足處以 NaN 填充,方便逐根對齊。

function nanArray(n) {
  return new Array(n).fill(Number.NaN);
}

export function sma(v, p) {
  const out = nanArray(v.length);
  if (p <= 0 || v.length < p) return out;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

// EMA;自動略過前面的 NaN(供 MACD 訊號線串接)。
export function ema(v, p) {
  const out = nanArray(v.length);
  if (p <= 0) return out;
  let start = 0;
  while (start < v.length && Number.isNaN(v[start])) start++;
  if (v.length - start < p) return out;
  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = start; i < start + p; i++) sum += v[i];
  let prev = sum / p;
  out[start + p - 1] = prev;
  for (let i = start + p; i < v.length; i++) {
    prev = (v[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(close, p) {
  const out = nanArray(close.length);
  if (close.length < p + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const ch = close[i] - close[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  const calc = (ag, al) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[p] = calc(avgGain, avgLoss);
  for (let i = p + 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}

export function macd(close, fast, slow, signal) {
  const emaFast = ema(close, fast);
  const emaSlow = ema(close, slow);
  const macdLine = nanArray(close.length);
  for (let i = 0; i < close.length; i++) {
    if (!Number.isNaN(emaFast[i]) && !Number.isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }
  const sig = ema(macdLine, signal);
  const hist = nanArray(close.length);
  for (let i = 0; i < close.length; i++) {
    if (!Number.isNaN(macdLine[i]) && !Number.isNaN(sig[i])) {
      hist[i] = macdLine[i] - sig[i];
    }
  }
  return { macd: macdLine, signal: sig, hist };
}

export function bollinger(close, p, mult) {
  const mid = sma(close, p);
  const upper = nanArray(close.length);
  const lower = nanArray(close.length);
  for (let i = p - 1; i < close.length; i++) {
    if (Number.isNaN(mid[i])) continue;
    let sumSq = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const d = close[j] - mid[i];
      sumSq += d * d;
    }
    const sd = Math.sqrt(sumSq / p);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function trueRange(high, low, prevClose) {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

export function atr(high, low, close, p) {
  const n = close.length;
  const out = nanArray(n);
  if (n < p + 1) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) tr[i] = trueRange(high[i], low[i], close[i - 1]);
  let sum = 0;
  for (let i = 1; i <= p; i++) sum += tr[i];
  let prev = sum / p;
  out[p] = prev;
  for (let i = p + 1; i < n; i++) {
    prev = (prev * (p - 1) + tr[i]) / p;
    out[i] = prev;
  }
  return out;
}

export function stochastic(high, low, close, kPeriod, dPeriod) {
  const n = close.length;
  const k = nanArray(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = high[i];
    let ll = low[i];
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    k[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
  }
  const d = sma(k, dPeriod);
  return { k, d };
}

export function adx(high, low, close, p) {
  const n = close.length;
  const out = nanArray(n);
  if (n < 2 * p + 1) return out;
  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    if (up > down && up > 0) plusDM[i] = up;
    if (down > up && down > 0) minusDM[i] = down;
    tr[i] = trueRange(high[i], low[i], close[i - 1]);
  }
  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= p; i++) {
    trS += tr[i];
    plusS += plusDM[i];
    minusS += minusDM[i];
  }
  const dx = nanArray(n);
  const calcDX = () => {
    if (trS === 0) return 0;
    const pDI = (100 * plusS) / trS;
    const mDI = (100 * minusS) / trS;
    if (pDI + mDI === 0) return 0;
    return (100 * Math.abs(pDI - mDI)) / (pDI + mDI);
  };
  dx[p] = calcDX();
  for (let i = p + 1; i < n; i++) {
    trS = trS - trS / p + tr[i];
    plusS = plusS - plusS / p + plusDM[i];
    minusS = minusS - minusS / p + minusDM[i];
    dx[i] = calcDX();
  }
  let sum = 0;
  for (let i = p + 1; i <= 2 * p; i++) sum += dx[i];
  let val = sum / p;
  out[2 * p] = val;
  for (let i = 2 * p + 1; i < n; i++) {
    val = (val * (p - 1) + dx[i]) / p;
    out[i] = val;
  }
  return out;
}

export function obv(close, volume) {
  const n = close.length;
  const out = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (close[i] > close[i - 1]) out[i] = out[i - 1] + volume[i];
    else if (close[i] < close[i - 1]) out[i] = out[i - 1] - volume[i];
    else out[i] = out[i - 1];
  }
  return out;
}
