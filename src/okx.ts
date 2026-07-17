// OKX v5 REST client:私有 API 簽名 + 統一請求包裝。零相依,只用 fetch/crypto.subtle/btoa。
// 簽名規格:base64(HMAC-SHA256(timestamp + method + requestPath(含 query) + body, secret))
// timestamp 為 ISO 毫秒格式(new Date().toISOString())。
const BASE = "https://www.okx.com";

// 帶型別的 OKX 業務錯誤(code !== "0");下單類失敗細節在 data[0].sCode/sMsg。
export class OkxError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(`OKX 錯誤 ${code}: ${msg}`);
    this.name = "OkxError";
    this.code = code;
  }
}

interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T;
}

export interface OkxCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// 從環境變數讀 API 憑證;缺任一即拋錯(fail-closed,不帶空憑證打 API)。
export function credsFromEnv(): OkxCreds {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) {
    throw new Error("缺少 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 環境變數");
  }
  return { apiKey, secret, passphrase };
}

// 專案交易對 → OKX 永續合約 instId:BTCUSDT → BTC-USDT-SWAP。
export function instIdOf(symbol: string): string {
  const base = symbol.toUpperCase().replace(/USDT$/, "");
  return `${base}-USDT-SWAP`;
}

export async function sign(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}${method}${path}${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 統一請求:網路錯誤與 429/5xx 各重試一次(下單是冪等鍵保護下的單次嘗試,不多retry);
// 業務錯誤(code !== "0")不重試,直接拋 OkxError。
export async function okxRequest<T>(
  creds: OkxCreds,
  method: "GET" | "POST",
  path: string,
  bodyObj?: unknown,
  attempt = 0,
): Promise<T> {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const timestamp = new Date().toISOString();
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": await sign(creds.secret, timestamp, method, path, body),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
    "Content-Type": "application/json",
  };
  let res: Response;
  try {
    // 逾時視為網路錯誤,走既有單次重試(見 I6)。
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (attempt < 1) {
      await sleep(300);
      return okxRequest<T>(creds, method, path, bodyObj, attempt + 1);
    }
    throw err;
  }
  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    if (attempt < 1) {
      await sleep(300);
      return okxRequest<T>(creds, method, path, bodyObj, attempt + 1);
    }
    throw new Error(`OKX 回應 ${res.status}`);
  }
  const parsed = (await res.json()) as OkxResponse<T>;
  if (parsed.code !== "0") {
    const first = (parsed.data as Array<{ sCode?: string; sMsg?: string }> | undefined)?.[0];
    throw new OkxError(first?.sCode ?? parsed.code, first?.sMsg ?? parsed.msg);
  }
  return parsed.data;
}

// ── 帳戶與交易 endpoints ─────────────────────────────

export interface UsdtBalance {
  equity: number;
  available: number;
  unrealizedPnl: number;
}

// 交易帳戶 USDT 權益/可用/未實現。無 USDT 明細視為異常(fail-closed)。
export async function fetchUsdtBalance(creds: OkxCreds): Promise<UsdtBalance> {
  const data = await okxRequest<
    Array<{ details?: Array<{ ccy: string; eq: string; availBal: string; upl: string }> }>
  >(creds, "GET", "/api/v5/account/balance?ccy=USDT");
  const d = data[0]?.details?.find((x) => x.ccy === "USDT");
  if (!d) throw new Error("OKX 帳戶查無 USDT 明細");
  return { equity: Number(d.eq), available: Number(d.availBal), unrealizedPnl: Number(d.upl) };
}

// 合約規格。ctVal(每張合約幣量)轉數字參與運算;lotSz/minSz/tickSz 保留字串,
// 供步長取整時推導小數位數,避免浮點誤差。
export interface OkxInstrument {
  instId: string;
  ctVal: number;
  lotSz: string;
  minSz: string;
  tickSz: string;
}

export async function fetchInstrument(creds: OkxCreds, instId: string): Promise<OkxInstrument> {
  const data = await okxRequest<
    Array<{ instId: string; ctVal: string; lotSz: string; minSz: string; tickSz: string }>
  >(creds, "GET", `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`);
  const it = data[0];
  if (!it) throw new Error(`OKX 查無合約規格:${instId}`);
  return {
    instId: it.instId,
    ctVal: Number(it.ctVal),
    lotSz: it.lotSz,
    minSz: it.minSz,
    tickSz: it.tickSz,
  };
}

// 設定逐倉槓桿(下單前呼叫;同值重複設定無害)。
export async function setLeverage(creds: OkxCreds, instId: string, lever: number): Promise<void> {
  await okxRequest(creds, "POST", "/api/v5/account/set-leverage", {
    instId,
    lever: String(lever),
    mgnMode: "isolated",
  });
}

export interface LiveOrderParams {
  instId: string;
  side: "buy" | "sell";
  sz: string;
  tpPx: string;
  slPx: string;
}

// 市價單 + attached TP/SL(觸發後市價,ordPx=-1)。回傳 ordId。
export async function placeMarketWithTpSl(creds: OkxCreds, p: LiveOrderParams): Promise<string> {
  const data = await okxRequest<Array<{ ordId: string; sCode?: string; sMsg?: string }>>(
    creds,
    "POST",
    "/api/v5/trade/order",
    {
      instId: p.instId,
      tdMode: "isolated",
      side: p.side,
      ordType: "market",
      sz: p.sz,
      attachAlgoOrds: [{ tpTriggerPx: p.tpPx, tpOrdPx: "-1", slTriggerPx: p.slPx, slOrdPx: "-1" }],
    },
  );
  const first = data[0];
  if (!first || (first.sCode && first.sCode !== "0")) {
    throw new OkxError(first?.sCode ?? "unknown", first?.sMsg ?? "下單回應異常(無明細)");
  }
  return first.ordId;
}

export interface OkxPosition {
  instId: string;
  pos: number; // 正=多、負=空(net 模式)
  avgPx: number;
  markPx: number;
  upl: number;
  uplRatio: number;
  lever: string;
}

// 目前所有 SWAP 倉位(排除 pos=0 的殘留列)。
export async function fetchPositions(creds: OkxCreds): Promise<OkxPosition[]> {
  const data = await okxRequest<
    Array<{
      instId: string;
      pos: string;
      avgPx: string;
      markPx: string;
      upl: string;
      uplRatio: string;
      lever: string;
    }>
  >(creds, "GET", "/api/v5/account/positions?instType=SWAP");
  return data
    .filter((p) => Number(p.pos) !== 0)
    .map((p) => ({
      instId: p.instId,
      pos: Number(p.pos),
      avgPx: Number(p.avgPx),
      markPx: Number(p.markPx),
      upl: Number(p.upl),
      uplRatio: Number(p.uplRatio),
      lever: p.lever,
    }));
}

// 市價全平該合約倉位;autoCxl 同時撤掉掛著的 TP/SL algo 單。
export async function closePosition(creds: OkxCreds, instId: string): Promise<void> {
  await okxRequest(creds, "POST", "/api/v5/trade/close-position", {
    instId,
    mgnMode: "isolated",
    autoCxl: true,
  });
}
