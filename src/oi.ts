// 未平倉量(Open Interest)資料源與「OI 趨勢」分項。
//
// 設計理念:OI = 市場上未平倉合約總量,代表「有多少新錢進場」。
//  - OI 擴張(上升)+ 價漲 → 多方加碼,趨勢有燃料 → 偏多
//  - OI 擴張 + 價跌 → 空方加碼 → 偏空
//  - OI 收縮(下降)→ 部位在平倉/止損,動能來自舊倉了結,方向缺乏確信 → 中性(0)
//
// 防前視(look-ahead):第 i 根「收盤」時只能知道收盤時點(openTime+barMs)以前的 OI,
// 故 alignOiToKlines 只取 ts ≤ 該根收盤時間的 OI;evalAt/回測在第 i 根決策、第 i+1 根進場,皆不前視。

import * as ta from "./ta.js";
import type { Kline } from "./types.js";

// OI 來源用 Bybit v5:免 API key、`nextPageCursor` 游標可翻回 ~2021 年(4h 達數年),
// 遠勝 OKX rubik(僅 30 天 / 6 個月)。我們只取 OI 的「方向/趨勢」,跨所(K 線 OKX、
// OI Bybit)以代理使用;主流幣跨所 OI 方向高度相關,足夠當確認分項。
const BYBIT_OI_URL = "https://api.bybit.com/v5/market/open-interest";

export interface OiPoint {
  ts: number;
  oi: number; // 未平倉量(以合約張數計;我們只用其趨勢方向)
}

// 專案週期 → Bybit intervalTime(5min/15min/30min/1h/4h/1d)。
export function bybitInterval(interval: string): string {
  const unit = interval[interval.length - 1];
  if (unit === "m") return `${interval.slice(0, -1)}min`;
  return interval.toLowerCase();
}

// 抓 OI 歷史(Bybit linear 永續)。以游標往回翻頁至 maxBars 根。回傳由舊到新。
export async function fetchOiHistory(
  symbol: string,
  interval: string,
  maxBars = 4000,
): Promise<OiPoint[]> {
  const sym = symbol.toUpperCase();
  const iv = bybitInterval(interval);
  const points: OiPoint[] = [];
  let cursor: string | undefined;

  while (points.length < maxBars) {
    let url = `${BYBIT_OI_URL}?category=linear&symbol=${encodeURIComponent(sym)}&intervalTime=${iv}&limit=200`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bybit OI 回應 ${res.status}`);
    const body = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result: { list: Array<{ openInterest: string; timestamp: string }>; nextPageCursor?: string };
    };
    if (body.retCode !== 0) throw new Error(`Bybit OI 錯誤 ${body.retCode}: ${body.retMsg}`);
    const list = body.result?.list ?? [];
    if (list.length === 0) break;
    for (const r of list) points.push({ ts: Number(r.timestamp), oi: Number(r.openInterest) });
    cursor = body.result?.nextPageCursor;
    if (!cursor) break;
  }

  points.sort((a, b) => a.ts - b.ts); // 由舊到新
  return points;
}

// 把 OI 對齊到每根 K 線:回傳與 klines 等長的陣列,第 i 項 = 第 i 根「收盤時點」前最新的 OI。
// 收盤時點 = openTime + barMs。對齊不到(該根收盤前無任何 OI 資料)則為 NaN。
export function alignOiToKlines(klines: Kline[], oi: OiPoint[], barMs: number): number[] {
  const out = new Array(klines.length).fill(Number.NaN);
  let p = 0; // 指向 oi 中「ts ≤ 當前根收盤」的最後一筆
  for (let i = 0; i < klines.length; i++) {
    const closeTs = klines[i].openTime + barMs;
    while (p < oi.length && oi[p].ts <= closeTs) p++;
    if (p > 0) out[i] = oi[p - 1].oi; // p-1 為最後一筆 ts ≤ closeTs
  }
  return out;
}

// 對 NaN 缺口做前向填補(carry-forward),避免 EMA 中斷;前導 NaN 保留。
function ffill(v: number[]): number[] {
  const out = v.slice();
  let last = Number.NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) {
      if (!Number.isNaN(last)) out[i] = last;
    } else {
      last = out[i];
    }
  }
  return out;
}

export interface OiDirOptions {
  fast?: number; // OI 快速 EMA 期數
  slow?: number; // OI 慢速 EMA 期數
  priceLookback?: number; // 價格動能比較的回看根數
}

// OI 趨勢分項:回傳與 klines 等長、值域 {-1, 0, +1, NaN} 的方向序列。
//  +1 = OI 擴張且價漲(多方加碼);−1 = OI 擴張且價跌(空方加碼);0 = OI 收縮(無確信)。
// 與其他指標一樣 index-aligned、NaN-padded,便於日後併入 signal.ts 當加權分項。
export function oiDirSeries(klines: Kline[], oiAtBar: number[], opts: OiDirOptions = {}): number[] {
  const fast = opts.fast ?? 10;
  const slow = opts.slow ?? 30;
  const lookback = opts.priceLookback ?? 3;
  const oi = ffill(oiAtBar);
  const oiFast = ta.ema(oi, fast);
  const oiSlow = ta.ema(oi, slow);
  const close = klines.map((k) => k.close);

  const out = new Array(klines.length).fill(Number.NaN);
  for (let i = 0; i < klines.length; i++) {
    if (Number.isNaN(oiFast[i]) || Number.isNaN(oiSlow[i])) continue;
    const expanding = oiFast[i] - oiSlow[i] > 0;
    if (!expanding) {
      out[i] = 0; // OI 收縮:無方向確信
      continue;
    }
    if (i < lookback || Number.isNaN(close[i - lookback])) continue;
    const dPrice = close[i] - close[i - lookback];
    out[i] = dPrice > 0 ? 1 : dPrice < 0 ? -1 : 0;
  }
  return out;
}

// 由週期字串估算一根的毫秒數(對齊 OI 用)。
function intervalMs(interval: string): number {
  const unit = interval[interval.length - 1];
  const n = Number(interval.slice(0, -1)) || 1;
  const ms: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (ms[unit] ?? 0);
}

// live 用:抓 OI、對齊已收盤 K 線、回傳「最後一根」的 OI 趨勢方向(-1/0/1)。
// 任何失敗(抓取錯誤、週期不支援、資料不足)都回 null,讓卡片照常顯示、不套 OI(fail-soft)。
// 回測驗證採「不反對」過濾:僅在 OI 明確反向(回 -1 對做多 / +1 對做空)時降級觀望。
export async function evalOiDir(
  symbol: string,
  interval: string,
  klines: Kline[],
): Promise<number | null> {
  const bar = intervalMs(interval);
  if (bar <= 0) return null;
  try {
    const oi = await fetchOiHistory(symbol, interval, 200); // 一頁即足夠涵蓋 EMA30 暖機
    if (oi.length === 0) return null;
    const oiAtBar = alignOiToKlines(klines, oi, bar);
    const dirs = oiDirSeries(klines, oiAtBar);
    const last = dirs[dirs.length - 1];
    return Number.isNaN(last) ? null : last;
  } catch {
    return null;
  }
}
