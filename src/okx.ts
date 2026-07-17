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
    res = await fetch(`${BASE}${path}`, { method, headers, body: body || undefined });
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
