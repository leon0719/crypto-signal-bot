# OKX 自動下單 + Slack 開關 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4h 策略訊號自動在 OKX 下真實市價單(附交易所端 TP/SL),並可透過 Slack 指令啟動/停止/緊急平倉/查詢。

**Architecture:** 排程器(`scripts/scheduler.ts`)常駐行程內新增第二條 async 迴圈輪詢 Slack 控制頻道;`scripts/detect.ts` 掃描出 4h 新機會後,在紙上記帳之外呼叫 `executeLive()` 下真單。OKX 直連 v5 REST(零相依手寫 client),出場交給交易所 attached TP/SL。開關與帳本以 JSON 檔持久化(`./data/`,docker volume 已掛載),跨行程(scheduler ↔ detect 子行程)共享。

**Tech Stack:** Bun + TypeScript ESM、`crypto.subtle` HMAC 簽名、`bun:test` + stub `globalThis.fetch`。

**Spec:** `docs/superpowers/specs/2026-07-17-okx-live-trading-design.md`(先讀一遍)

## Global Constraints

- **零 runtime 相依**:只用 `fetch`/`crypto.subtle`/`btoa`/`node:fs/promises`。不加 npm 套件。
- 註解與所有使用者可見字串一律**繁體中文**。
- import 一律用 `.js` 副檔名(TS `verbatimModuleSyntax`)。
- 測試:`bun:test`,stub `globalThis.fetch` 以 URL 子字串分路,`afterEach` 裡 `mock.restore()`。
- 每個 task 結束跑 `bun test <該檔>` 與 `bun run check`(biome + tsc),綠了才 commit。
- fail-closed:任何拿不到的資料(餘額、規格、開關檔)都導向「不下單」,絕不用猜的參數下單。
- `LIVE_MODE` 預設 `dry`;只有明確設 `real` 才打下單 API。

---

### Task 1: `src/okx.ts` — client 核心(簽名 + 請求包裝)

**Files:**
- Create: `src/okx.ts`
- Test: `src/okx.test.ts`

**Interfaces:**
- Produces:
  - `class OkxError extends Error { code: string }`
  - `interface OkxCreds { apiKey: string; secret: string; passphrase: string }`
  - `credsFromEnv(): OkxCreds`(缺 env 拋錯)
  - `sign(secret, timestamp, method, path, body): Promise<string>`(base64 HMAC-SHA256)
  - `okxRequest<T>(creds, method: "GET"|"POST", path, bodyObj?): Promise<T>`
  - `instIdOf(symbol: string): string`(`BTCUSDT` → `BTC-USDT-SWAP`)

- [ ] **Step 1: 寫失敗測試**

```ts
// src/okx.test.ts
import { afterEach, describe, expect, it, mock } from "bun:test";
import { instIdOf, OkxError, okxRequest, sign } from "./okx.js";

const CREDS = { apiKey: "key", secret: "secret", passphrase: "pass" };

afterEach(() => {
  mock.restore();
});

describe("instIdOf", () => {
  it("BTCUSDT 轉 BTC-USDT-SWAP", () => {
    expect(instIdOf("BTCUSDT")).toBe("BTC-USDT-SWAP");
    expect(instIdOf("1000pepeusdt".toUpperCase())).toBe("1000PEPE-USDT-SWAP");
  });
});

describe("sign", () => {
  it("簽名可被 HMAC-SHA256 驗證(prehash = ts+method+path+body)", async () => {
    const ts = "2020-12-08T09:08:57.715Z";
    const path = "/api/v5/account/balance?ccy=USDT";
    const sig = await sign("secret", ts, "GET", path, "");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const raw = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      raw,
      new TextEncoder().encode(`${ts}GET${path}`),
    );
    expect(ok).toBe(true);
  });
});

describe("okxRequest", () => {
  it("成功時回傳 data,並帶齊簽名 headers", async () => {
    let captured: Request | null = null;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify({ code: "0", msg: "", data: [{ ok: 1 }] }));
    }) as unknown as typeof fetch;

    const data = await okxRequest<Array<{ ok: number }>>(CREDS, "GET", "/api/v5/x");
    expect(data[0].ok).toBe(1);
    const req = captured as unknown as Request;
    expect(req.headers.get("OK-ACCESS-KEY")).toBe("key");
    expect(req.headers.get("OK-ACCESS-PASSPHRASE")).toBe("pass");
    expect(req.headers.get("OK-ACCESS-SIGN")).toBeTruthy();
    expect(req.headers.get("OK-ACCESS-TIMESTAMP")).toBeTruthy();
  });

  it("業務錯誤(code!=0)拋 OkxError,含下單 sCode/sMsg,且不重試", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({ code: "1", msg: "op fail", data: [{ sCode: "51008", sMsg: "餘額不足" }] }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(okxRequest(CREDS, "POST", "/api/v5/trade/order", {})).rejects.toThrow(OkxError);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("網路錯誤重試一次,再失敗就拋出", async () => {
    const fetchMock = mock(async () => {
      throw new Error("網路斷線");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(okxRequest(CREDS, "GET", "/api/v5/x")).rejects.toThrow("網路斷線");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("5xx 重試一次後成功", async () => {
    let n = 0;
    globalThis.fetch = mock(async () => {
      n++;
      if (n === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    await expect(okxRequest(CREDS, "GET", "/api/v5/x")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/okx.test.ts`
Expected: FAIL(模組不存在)

- [ ] **Step 3: 實作**

```ts
// src/okx.ts
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/okx.test.ts && bun run check`
Expected: PASS、check 無錯

- [ ] **Step 5: Commit**

```bash
git add src/okx.ts src/okx.test.ts
git commit -m "feat: OKX v5 REST client 核心(簽名+請求包裝)"
```

---

### Task 2: `src/okx.ts` — 帳戶/交易 endpoints

**Files:**
- Modify: `src/okx.ts`(追加於檔尾)
- Test: `src/okx.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `okxRequest`、`OkxCreds`
- Produces:
  - `interface UsdtBalance { equity: number; available: number; unrealizedPnl: number }`
  - `fetchUsdtBalance(creds): Promise<UsdtBalance>`
  - `interface OkxInstrument { instId: string; ctVal: number; lotSz: string; minSz: string; tickSz: string }`(步長保留字串,取整不失真)
  - `fetchInstrument(creds, instId): Promise<OkxInstrument>`
  - `setLeverage(creds, instId, lever: number): Promise<void>`(逐倉)
  - `interface LiveOrderParams { instId: string; side: "buy"|"sell"; sz: string; tpPx: string; slPx: string }`
  - `placeMarketWithTpSl(creds, p: LiveOrderParams): Promise<string>`(回 ordId)
  - `interface OkxPosition { instId: string; pos: number; avgPx: number; markPx: number; upl: number; uplRatio: number; lever: string }`
  - `fetchPositions(creds): Promise<OkxPosition[]>`(SWAP 全部、`pos !== 0`)
  - `closePosition(creds, instId): Promise<void>`(市價全平 + `autoCxl` 撤該倉 algo 單)

- [ ] **Step 1: 寫失敗測試(追加到 `src/okx.test.ts`)**

```ts
import {
  closePosition,
  fetchInstrument,
  fetchPositions,
  fetchUsdtBalance,
  placeMarketWithTpSl,
} from "./okx.js";

// 依 URL 分路的 fetch stub;回傳 {url, body} 記錄供斷言。
function stubOkx(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    for (const [frag, data] of Object.entries(routes)) {
      if (url.includes(frag)) {
        return new Response(JSON.stringify({ code: "0", msg: "", data }));
      }
    }
    return new Response(JSON.stringify({ code: "1", msg: `無路由 ${url}`, data: [] }));
  }) as unknown as typeof fetch;
  return calls;
}

describe("endpoints", () => {
  it("fetchUsdtBalance 取 USDT 明細", async () => {
    stubOkx({
      "/account/balance": [
        { details: [{ ccy: "USDT", eq: "2000.5", availBal: "1500", upl: "-12.3" }] },
      ],
    });
    const b = await fetchUsdtBalance(CREDS);
    expect(b).toEqual({ equity: 2000.5, available: 1500, unrealizedPnl: -12.3 });
  });

  it("fetchUsdtBalance 無 USDT 明細時拋錯(fail-closed)", async () => {
    stubOkx({ "/account/balance": [{ details: [] }] });
    await expect(fetchUsdtBalance(CREDS)).rejects.toThrow("USDT");
  });

  it("fetchInstrument 回合約規格(步長保留字串)", async () => {
    stubOkx({
      "/public/instruments": [
        { instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" },
      ],
    });
    const inst = await fetchInstrument(CREDS, "BTC-USDT-SWAP");
    expect(inst.ctVal).toBe(0.01);
    expect(inst.lotSz).toBe("0.1");
    expect(inst.tickSz).toBe("0.1");
  });

  it("placeMarketWithTpSl 送出市價單與 attached TP/SL,回 ordId", async () => {
    const calls = stubOkx({ "/trade/order": [{ ordId: "123", sCode: "0", sMsg: "" }] });
    const ordId = await placeMarketWithTpSl(CREDS, {
      instId: "BTC-USDT-SWAP",
      side: "sell",
      sz: "1.5",
      tpPx: "60000.0",
      slPx: "70000.0",
    });
    expect(ordId).toBe("123");
    const body = calls[0].body as Record<string, unknown>;
    expect(body.tdMode).toBe("isolated");
    expect(body.ordType).toBe("market");
    const algo = (body.attachAlgoOrds as Array<Record<string, string>>)[0];
    expect(algo.tpTriggerPx).toBe("60000.0");
    expect(algo.slTriggerPx).toBe("70000.0");
    expect(algo.tpOrdPx).toBe("-1"); // 觸發後市價
    expect(algo.slOrdPx).toBe("-1");
  });

  it("fetchPositions 過濾掉 pos=0 並轉數字", async () => {
    stubOkx({
      "/account/positions": [
        { instId: "BTC-USDT-SWAP", pos: "-2", avgPx: "65000", markPx: "64000", upl: "20", uplRatio: "0.05", lever: "3" },
        { instId: "ETH-USDT-SWAP", pos: "0", avgPx: "", markPx: "", upl: "", uplRatio: "", lever: "" },
      ],
    });
    const ps = await fetchPositions(CREDS);
    expect(ps.length).toBe(1);
    expect(ps[0].pos).toBe(-2);
    expect(ps[0].uplRatio).toBeCloseTo(0.05);
  });

  it("closePosition 帶 autoCxl 撤保護單", async () => {
    const calls = stubOkx({ "/trade/close-position": [{}] });
    await closePosition(CREDS, "BTC-USDT-SWAP");
    const body = calls[0].body as Record<string, unknown>;
    expect(body.mgnMode).toBe("isolated");
    expect(body.autoCxl).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/okx.test.ts`
Expected: FAIL(函式未定義)

- [ ] **Step 3: 實作(追加到 `src/okx.ts`)**

```ts
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
  return { instId: it.instId, ctVal: Number(it.ctVal), lotSz: it.lotSz, minSz: it.minSz, tickSz: it.tickSz };
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
  const data = await okxRequest<Array<{ ordId: string }>>(creds, "POST", "/api/v5/trade/order", {
    instId: p.instId,
    tdMode: "isolated",
    side: p.side,
    ordType: "market",
    sz: p.sz,
    attachAlgoOrds: [
      { tpTriggerPx: p.tpPx, tpOrdPx: "-1", slTriggerPx: p.slPx, slOrdPx: "-1" },
    ],
  });
  return data[0].ordId;
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
    Array<{ instId: string; pos: string; avgPx: string; markPx: string; upl: string; uplRatio: string; lever: string }>
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/okx.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/okx.ts src/okx.test.ts
git commit -m "feat: OKX 帳戶/交易 endpoints(餘額、規格、下單、倉位、平倉)"
```

---

### Task 3: `src/live-state.ts` — 實盤帳本與開關持久化

**Files:**
- Create: `src/live-state.ts`
- Test: `src/live-state.test.ts`

**Interfaces:**
- Produces:
  - `interface LivePosition { key: string; symbol: string; instId: string; dir: "LONG"|"SHORT"; contracts: string; entry: number; stop: number; target: number; leverage: number; mode: "dry"|"real"; ordId: string|null; openedAt: string; status: "OPEN"|"CLOSED"; closedAt?: string; closeReason?: string }`
  - `interface LiveLedger { positions: LivePosition[]; updatedAt?: string }`
  - `readLiveLedger(path): Promise<LiveLedger>`(fail-soft 空帳)
  - `writeLiveLedger(path, ledger): Promise<void>`(tmp→rename 原子寫)
  - `interface ControlState { enabled: boolean; updatedAt?: string }`
  - `readControlState(path): Promise<ControlState>`(讀不到 → `{enabled:false}`,fail-closed)
  - `writeControlState(path, state): Promise<void>`

- [ ] **Step 1: 寫失敗測試**

```ts
// src/live-state.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LivePosition,
  readControlState,
  readLiveLedger,
  writeControlState,
  writeLiveLedger,
} from "./live-state.js";

const pos = (over: Partial<LivePosition> = {}): LivePosition => ({
  key: "BTCUSDT:SHORT:1700000000000",
  symbol: "BTCUSDT",
  instId: "BTC-USDT-SWAP",
  dir: "SHORT",
  contracts: "1.5",
  entry: 65000,
  stop: 67000,
  target: 62000,
  leverage: 3,
  mode: "dry",
  ordId: null,
  openedAt: "2026-07-17T00:00:00.000Z",
  status: "OPEN",
  ...over,
});

describe("live-state", () => {
  it("ledger 讀不到檔回空帳;寫入後可讀回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "ledger.json");
    expect((await readLiveLedger(p)).positions).toEqual([]);
    await writeLiveLedger(p, { positions: [pos()] });
    const back = await readLiveLedger(p);
    expect(back.positions.length).toBe(1);
    expect(back.positions[0].instId).toBe("BTC-USDT-SWAP");
    await rm(dir, { recursive: true });
  });

  it("控制檔不存在 → enabled:false(fail-closed);寫入後可讀回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "control.json");
    expect((await readControlState(p)).enabled).toBe(false);
    await writeControlState(p, { enabled: true });
    expect((await readControlState(p)).enabled).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("控制檔內容損壞 → enabled:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-"));
    const p = join(dir, "control.json");
    await Bun.write(p, "not json");
    expect((await readControlState(p)).enabled).toBe(false);
    await rm(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/live-state.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
// src/live-state.ts
// 實盤下單的持久化:帳本(live ledger)與自動下單開關(control state)。
// 兩者都是 JSON 檔,沿用 paper-state 的原子寫檔(tmp→rename)。
// 開關 fail-closed:讀不到/壞掉一律視為「關閉」;帳本 fail-soft:讀不到當空帳。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LivePosition {
  key: string; // 冪等鍵:symbol:dir:barOpenTime
  symbol: string;
  instId: string;
  dir: "LONG" | "SHORT";
  contracts: string; // 合約張數(字串,依 lotSz 位數)
  entry: number;
  stop: number;
  target: number;
  leverage: number;
  mode: "dry" | "real";
  ordId: string | null; // dry 模式為 null
  openedAt: string;
  status: "OPEN" | "CLOSED";
  closedAt?: string;
  closeReason?: string;
}

export interface LiveLedger {
  positions: LivePosition[];
  updatedAt?: string;
}

export interface ControlState {
  enabled: boolean;
  updatedAt?: string;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readLiveLedger(path: string): Promise<LiveLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LiveLedger>;
    return { positions: Array.isArray(parsed.positions) ? parsed.positions : [] };
  } catch {
    return { positions: [] };
  }
}

export async function writeLiveLedger(path: string, ledger: LiveLedger): Promise<void> {
  await writeJsonAtomic(path, { ...ledger, updatedAt: new Date().toISOString() });
}

export async function readControlState(path: string): Promise<ControlState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ControlState>;
    return { enabled: parsed.enabled === true };
  } catch {
    return { enabled: false };
  }
}

export async function writeControlState(path: string, state: ControlState): Promise<void> {
  await writeJsonAtomic(path, { ...state, updatedAt: new Date().toISOString() });
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/live-state.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/live-state.ts src/live-state.test.ts
git commit -m "feat: 實盤帳本與自動下單開關的 JSON 持久化"
```

---

### Task 4: `src/live.ts` — 純函式:張數換算與下單計畫

**Files:**
- Create: `src/live.ts`
- Test: `src/live.test.ts`

**Interfaces:**
- Consumes: `Opportunity`(`src/detect.ts`)、`OkxInstrument`(Task 2)、`suggestLeverage`(`src/risk.ts`)
- Produces:
  - `floorToStep(value: number, step: string): string`(依步長向下取整,回字串)
  - `roundToStep(value: number, step: string): string`(四捨五入,tick 用)
  - `barOpenOf(now: number, intervalMs: number): number`
  - `type OrderPlan = { instId; side: "buy"|"sell"; contracts: string; leverage: number; notional: number; margin: number; tpPx: string; slPx: string }`
  - `planOrder(o: Opportunity, equity: number, inst: OkxInstrument, riskPct: number): OrderPlan | { skip: string }`

- [ ] **Step 1: 寫失敗測試**

```ts
// src/live.test.ts
import { describe, expect, it } from "bun:test";
import type { Opportunity } from "./detect.js";
import type { OkxInstrument } from "./okx.js";
import { barOpenOf, floorToStep, planOrder, roundToStep } from "./live.js";

const INST: OkxInstrument = {
  instId: "BTC-USDT-SWAP",
  ctVal: 0.01,
  lotSz: "0.1",
  minSz: "0.1",
  tickSz: "0.1",
};

const opp = (over: Partial<Opportunity> = {}): Opportunity => ({
  symbol: "BTCUSDT",
  dir: "SHORT",
  entry: 65000,
  stop: 67000, // 2×ATR=2000 → ATR=1000,atrPct≈1.54 → 槓桿 3x(risk.ts)
  target: 62000,
  score: -5,
  regime: "趨勢",
  adx: 30,
  htf1d: -3,
  oi: -1,
  ...over,
});

describe("步長取整", () => {
  it("floorToStep 依步長向下取整並保留位數", () => {
    expect(floorToStep(1.2345, "0.1")).toBe("1.2");
    expect(floorToStep(7, "1")).toBe("7");
    expect(floorToStep(0.29999999, "0.001")).toBe("0.299");
  });
  it("roundToStep 四捨五入到步長", () => {
    expect(roundToStep(64999.96, "0.1")).toBe("65000.0");
    expect(roundToStep(0.123456, "0.0001")).toBe("0.1235");
  });
});

describe("barOpenOf", () => {
  it("對齊週期開盤時間", () => {
    const fourH = 4 * 3_600_000;
    expect(barOpenOf(fourH * 10 + 123456, fourH)).toBe(fourH * 10);
  });
});

describe("planOrder", () => {
  it("風險 1%:數量 = 權益×1% ÷ 停損距離,換成合約張數", () => {
    // 權益 2000 → 風險 20 USDT;停損距離 2000 → 0.01 BTC → ctVal 0.01 → 1 張
    const plan = planOrder(opp(), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.contracts).toBe("1.0");
    expect(plan.side).toBe("sell"); // SHORT → sell
    expect(plan.leverage).toBe(3);
    expect(plan.tpPx).toBe("62000.0"); // target
    expect(plan.slPx).toBe("67000.0"); // stop
    expect(plan.notional).toBeCloseTo(1 * 0.01 * 65000);
    expect(plan.margin).toBeCloseTo(plan.notional / 3);
  });

  it("LONG → buy", () => {
    const plan = planOrder(opp({ dir: "LONG", stop: 63000, target: 68000 }), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.side).toBe("buy");
  });

  it("低於最小下單量 → skip", () => {
    // 權益 100 → 風險 1 USDT;距離 2000 → 0.0005 BTC = 0.05 張 < minSz 0.1
    const plan = planOrder(opp(), 100, INST, 0.01);
    expect("skip" in plan && plan.skip).toContain("最小下單量");
  });

  it("停損距離為 0 → skip(fail-closed)", () => {
    const plan = planOrder(opp({ stop: 65000 }), 2000, INST, 0.01);
    expect("skip" in plan).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/live.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
// src/live.ts
// 實盤下單:訊號 → 護欄 → 部位計算 → OKX 下單 → 記帳/通報。
// 部位規則與紙上一致:每筆風險 = 權益 × riskPct(2×ATR 停損),槓桿依 ATR 動態(risk.ts)。
import type { Opportunity } from "./detect.js";
import type { OkxInstrument } from "./okx.js";
import { suggestLeverage } from "./risk.js";

// 依字串步長向下取整,回傳與步長同小數位數的字串(避免浮點誤差與科學記號)。
export function floorToStep(value: number, step: string): string {
  const dec = (step.split(".")[1] ?? "").length;
  const n = Math.floor(value / Number(step) + 1e-9) * Number(step);
  return n.toFixed(dec);
}

// 四捨五入到步長(TP/SL 觸發價貼齊 tickSz 用)。
export function roundToStep(value: number, step: string): string {
  const dec = (step.split(".")[1] ?? "").length;
  const n = Math.round(value / Number(step)) * Number(step);
  return n.toFixed(dec);
}

// 目前所屬 K 棒的開盤時間(冪等鍵用:同一根棒只下一次單)。
export function barOpenOf(now: number, intervalMs: number): number {
  return Math.floor(now / intervalMs) * intervalMs;
}

export interface OrderPlan {
  instId: string;
  side: "buy" | "sell";
  contracts: string;
  leverage: number;
  notional: number; // 名目價值(USDT)
  margin: number; // 佔用保證金 = notional / leverage
  tpPx: string;
  slPx: string;
}

// 由機會與帳戶權益算出下單計畫;不可下單時回 {skip: 原因}。純函式,好測。
export function planOrder(
  o: Opportunity,
  equity: number,
  inst: OkxInstrument,
  riskPct: number,
): OrderPlan | { skip: string } {
  const stopDist = Math.abs(o.entry - o.stop);
  if (!(stopDist > 0) || !(equity > 0)) return { skip: "停損距離或權益無效" };
  const riskAmount = equity * riskPct;
  const qtyCoin = riskAmount / stopDist;
  const contracts = floorToStep(qtyCoin / inst.ctVal, inst.lotSz);
  if (Number(contracts) < Number(inst.minSz)) {
    return {
      skip: `張數 ${contracts} 低於最小下單量 ${inst.minSz}(風險額 ${riskAmount.toFixed(1)} USDT 太小)`,
    };
  }
  const leverage = suggestLeverage(stopDist / 2, o.entry); // 停損距離 = 2×ATR
  const notional = Number(contracts) * inst.ctVal * o.entry;
  return {
    instId: inst.instId,
    side: o.dir === "SHORT" ? "sell" : "buy",
    contracts,
    leverage,
    notional,
    margin: notional / leverage,
    tpPx: roundToStep(o.target, inst.tickSz),
    slPx: roundToStep(o.stop, inst.tickSz),
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/live.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/live.ts src/live.test.ts
git commit -m "feat: 實盤張數換算與下單計畫(純函式)"
```

---

### Task 5: `src/live.ts` — `executeLive` 協調流程與對帳

**Files:**
- Modify: `src/live.ts`(追加)
- Test: `src/live.test.ts`(追加)

**Interfaces:**
- Consumes: Task 2 全部 endpoints、Task 3 `readLiveLedger`/`writeLiveLedger`/`readControlState`、Task 4 `planOrder`/`barOpenOf`
- Produces:
  - `interface LiveConfig { mode: "dry"|"real"; riskPct: number; maxPositions: number; ledgerPath: string; controlPath: string; intervalMs: number }`
  - `interface LiveIo { creds: OkxCreds; notify(text: string): Promise<void>; lastPrice(symbol: string): Promise<number|null>; now(): number }`
  - `liveConfigFromEnv(intervalMs: number): LiveConfig`(`LIVE_MODE` 預設 dry、`LIVE_MAX_POSITIONS` 預設 4、`LIVE_LEDGER_PATH` 預設 `./data/live-ledger.json`、`LIVE_CONTROL_PATH` 預設 `./data/live-control.json`)
  - `reconcileLedger(ledger, cfg, io): Promise<string[]>`(標記已被交易所端出場的部位,回傳被關閉的 key)
  - `executeLive(news: Opportunity[], cfg, io): Promise<{ opened: number; skipped: string[] }>`

**行為規格:**
1. `readControlState(cfg.controlPath)` 關閉 → 直接回 `{opened:0, skipped:["自動下單未啟動"]}`,不打任何 OKX API。
2. 對帳 `reconcileLedger`:real → `fetchPositions`,ledger 中 OPEN+real 但交易所已無倉位者標 CLOSED(`closeReason:"交易所端已出場"`);dry → 以 `io.lastPrice` 判斷是否觸及 stop/target,是則標 CLOSED(`closeReason:"【模擬】觸及停損"`/`"【模擬】達標"`)。對帳結果寫回 ledger。
3. `news` 非空才 `fetchUsdtBalance` 一次;失敗 → notify 告警並中止整輪(fail-closed)。
4. 逐筆:護欄(同 symbol 同 mode 已有 OPEN → skip;OPEN 數(同 mode)≥ maxPositions → skip;冪等鍵已存在(任何 status)→ skip)→ `fetchInstrument` → `planOrder` → real 時 `setLeverage`+`placeMarketWithTpSl`;dry 不打 API → push 進 ledger(mode 標記)→ notify 成功訊息(dry 加「【模擬】」前綴)。
5. 單筆失敗(OkxError/fetch 錯)→ notify 告警,繼續下一筆。
6. 結束 `writeLiveLedger`。

- [ ] **Step 1: 寫失敗測試(追加到 `src/live.test.ts`)**

```ts
import { afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveLedger, writeControlState, writeLiveLedger } from "./live-state.js";
import { executeLive, type LiveConfig, type LiveIo, reconcileLedger } from "./live.js";

afterEach(() => {
  mock.restore();
});

// OKX API stub:依 URL 分路;記錄下單 body。
function stubOkxApi(overrides: Partial<Record<string, unknown>> = {}) {
  const orders: unknown[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (data: unknown) =>
      new Response(JSON.stringify({ code: "0", msg: "", data }));
    if (url.includes("/account/balance")) {
      return reply(
        overrides.balance ?? [
          { details: [{ ccy: "USDT", eq: "2000", availBal: "2000", upl: "0" }] },
        ],
      );
    }
    if (url.includes("/public/instruments")) {
      return reply([
        { instId: "BTC-USDT-SWAP", ctVal: "0.01", lotSz: "0.1", minSz: "0.1", tickSz: "0.1" },
      ]);
    }
    if (url.includes("/account/set-leverage")) return reply([{}]);
    if (url.includes("/trade/order")) {
      orders.push(init?.body ? JSON.parse(String(init.body)) : null);
      return reply([{ ordId: "ord-1", sCode: "0", sMsg: "" }]);
    }
    if (url.includes("/account/positions")) return reply(overrides.positions ?? []);
    return new Response(JSON.stringify({ code: "1", msg: `無路由 ${url}`, data: [] }));
  }) as unknown as typeof fetch;
  return orders;
}

async function makeEnv(mode: "dry" | "real", enabled: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "live-exec-"));
  const cfg: LiveConfig = {
    mode,
    riskPct: 0.01,
    maxPositions: 4,
    ledgerPath: join(dir, "ledger.json"),
    controlPath: join(dir, "control.json"),
    intervalMs: 4 * 3_600_000,
  };
  await writeControlState(cfg.controlPath, { enabled });
  const notes: string[] = [];
  const io: LiveIo = {
    creds: { apiKey: "k", secret: "s", passphrase: "p" },
    notify: async (t) => {
      notes.push(t);
    },
    lastPrice: async () => null,
    now: () => 4 * 3_600_000 * 1000, // 固定時間,冪等鍵可預測
  };
  return { dir, cfg, io, notes };
}

describe("executeLive", () => {
  it("開關關閉:不打 API、不下單", async () => {
    const { dir, cfg, io } = await makeEnv("real", false);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(orders.length).toBe(0);
    await rm(dir, { recursive: true });
  });

  it("real 模式:下單、寫帳、通報", async () => {
    const { dir, cfg, io, notes } = await makeEnv("real", true);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(1);
    expect(orders.length).toBe(1);
    const ledger = await readLiveLedger(cfg.ledgerPath);
    expect(ledger.positions[0].mode).toBe("real");
    expect(ledger.positions[0].ordId).toBe("ord-1");
    expect(notes.some((t) => t.includes("BTCUSDT"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("dry 模式:不打下單 API,但寫帳(mode:dry)並通報【模擬】", async () => {
    const { dir, cfg, io, notes } = await makeEnv("dry", true);
    const orders = stubOkxApi();
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(1);
    expect(orders.length).toBe(0); // 不打 /trade/order
    const ledger = await readLiveLedger(cfg.ledgerPath);
    expect(ledger.positions[0].mode).toBe("dry");
    expect(ledger.positions[0].ordId).toBeNull();
    expect(notes.some((t) => t.includes("【模擬】"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("冪等:同一根棒同訊號跑兩次只下一次單", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    const orders = stubOkxApi();
    await executeLive([opp()], cfg, io);
    const res2 = await executeLive([opp()], cfg, io);
    expect(res2.opened).toBe(0);
    expect(orders.length).toBe(1);
    await rm(dir, { recursive: true });
  });

  it("倉位上限:OPEN 達上限後跳過新訊號", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    cfg.maxPositions = 1;
    stubOkxApi({ positions: [{ instId: "ETH-USDT-SWAP", pos: "1", avgPx: "3000", markPx: "3000", upl: "0", uplRatio: "0", lever: "3" }] });
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "ETHUSDT:LONG:0", symbol: "ETHUSDT", instId: "ETH-USDT-SWAP", dir: "LONG",
          contracts: "1", entry: 3000, stop: 2900, target: 3200, leverage: 3,
          mode: "real", ordId: "x", openedAt: "", status: "OPEN",
        },
      ],
    });
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(res.skipped.some((s) => s.includes("上限"))).toBe(true);
    await rm(dir, { recursive: true });
  });

  it("餘額查詢失敗:整輪中止並告警(fail-closed)", async () => {
    const { dir, cfg, io, notes } = await makeEnv("real", true);
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/account/positions")) {
        return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
      }
      return new Response(JSON.stringify({ code: "50000", msg: "服務異常", data: [] }));
    }) as unknown as typeof fetch;
    const res = await executeLive([opp()], cfg, io);
    expect(res.opened).toBe(0);
    expect(notes.some((t) => t.includes("告警") || t.includes("失敗"))).toBe(true);
    await rm(dir, { recursive: true });
  });
});

describe("reconcileLedger", () => {
  it("real:交易所已無倉位 → 標 CLOSED", async () => {
    const { dir, cfg, io } = await makeEnv("real", true);
    stubOkxApi({ positions: [] }); // 交易所空倉
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "BTCUSDT:SHORT:0", symbol: "BTCUSDT", instId: "BTC-USDT-SWAP", dir: "SHORT",
          contracts: "1", entry: 65000, stop: 67000, target: 62000, leverage: 3,
          mode: "real", ordId: "x", openedAt: "", status: "OPEN",
        },
      ],
    });
    const ledger = await readLiveLedger(cfg.ledgerPath);
    const closed = await reconcileLedger(ledger, cfg, io);
    expect(closed).toEqual(["BTCUSDT:SHORT:0"]);
    expect(ledger.positions[0].status).toBe("CLOSED");
    await rm(dir, { recursive: true });
  });

  it("dry:現價觸及停損 → 標 CLOSED(模擬)", async () => {
    const { dir, cfg, io } = await makeEnv("dry", true);
    io.lastPrice = async () => 67500; // SHORT 停損 67000 已觸及
    await writeLiveLedger(cfg.ledgerPath, {
      positions: [
        {
          key: "BTCUSDT:SHORT:0", symbol: "BTCUSDT", instId: "BTC-USDT-SWAP", dir: "SHORT",
          contracts: "1", entry: 65000, stop: 67000, target: 62000, leverage: 3,
          mode: "dry", ordId: null, openedAt: "", status: "OPEN",
        },
      ],
    });
    const ledger = await readLiveLedger(cfg.ledgerPath);
    const closed = await reconcileLedger(ledger, cfg, io);
    expect(closed.length).toBe(1);
    expect(ledger.positions[0].closeReason).toContain("模擬");
    await rm(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/live.test.ts`
Expected: FAIL(executeLive 未定義)

- [ ] **Step 3: 實作(追加到 `src/live.ts`)**

```ts
import {
  fetchInstrument,
  fetchPositions,
  fetchUsdtBalance,
  instIdOf,
  type OkxCreds,
  placeMarketWithTpSl,
  setLeverage,
} from "./okx.js";
import {
  type LiveLedger,
  type LivePosition,
  readControlState,
  readLiveLedger,
  writeLiveLedger,
} from "./live-state.js";

export interface LiveConfig {
  mode: "dry" | "real";
  riskPct: number;
  maxPositions: number;
  ledgerPath: string;
  controlPath: string;
  intervalMs: number;
}

export interface LiveIo {
  creds: OkxCreds;
  notify(text: string): Promise<void>;
  lastPrice(symbol: string): Promise<number | null>; // dry 對帳用(現貨/合約現價)
  now(): number;
}

// 由環境變數組實盤設定。LIVE_MODE 只認 "real",其餘一律 dry(fail-closed)。
export function liveConfigFromEnv(intervalMs: number): LiveConfig {
  return {
    mode: process.env.LIVE_MODE === "real" ? "real" : "dry",
    riskPct: 0.01,
    maxPositions: Number(process.env.LIVE_MAX_POSITIONS ?? 4),
    ledgerPath: process.env.LIVE_LEDGER_PATH ?? "./data/live-ledger.json",
    controlPath: process.env.LIVE_CONTROL_PATH ?? "./data/live-control.json",
    intervalMs,
  };
}

// 對帳:把「交易所端已出場」的 OPEN 部位標記 CLOSED,騰出倉位額度。
// real:以 OKX 實際倉位為準;dry:以現價是否觸及 stop/target 模擬。回傳被關閉的 key。
export async function reconcileLedger(
  ledger: LiveLedger,
  cfg: LiveConfig,
  io: LiveIo,
): Promise<string[]> {
  const closed: string[] = [];
  const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
  if (opens.length === 0) return closed;

  if (cfg.mode === "real") {
    const live = new Set((await fetchPositions(io.creds)).map((p) => p.instId));
    for (const p of opens) {
      if (!live.has(p.instId)) {
        p.status = "CLOSED";
        p.closedAt = new Date(io.now()).toISOString();
        p.closeReason = "交易所端已出場(TP/SL 或手動)";
        closed.push(p.key);
      }
    }
  } else {
    for (const p of opens) {
      const px = await io.lastPrice(p.symbol);
      if (px == null) continue; // 取不到價就下輪再說
      const hitStop = p.dir === "SHORT" ? px >= p.stop : px <= p.stop;
      const hitTarget = p.dir === "SHORT" ? px <= p.target : px >= p.target;
      if (hitStop || hitTarget) {
        p.status = "CLOSED";
        p.closedAt = new Date(io.now()).toISOString();
        p.closeReason = hitStop ? "【模擬】觸及停損" : "【模擬】達標";
        closed.push(p.key);
      }
    }
  }
  return closed;
}

const fmtUsdt = (n: number) => `${n.toFixed(1)} USDT`;

// 主流程:開關 → 對帳 → 護欄 → 下單 → 記帳/通報。單筆失敗告警後續下一筆;
// 餘額查詢失敗中止整輪(fail-closed)。
export async function executeLive(
  news: Opportunity[],
  cfg: LiveConfig,
  io: LiveIo,
): Promise<{ opened: number; skipped: string[] }> {
  const skipped: string[] = [];
  const control = await readControlState(cfg.controlPath);
  if (!control.enabled) return { opened: 0, skipped: ["自動下單未啟動"] };

  const ledger = await readLiveLedger(cfg.ledgerPath);
  const reconciled = await reconcileLedger(ledger, cfg, io).catch((e) => {
    skipped.push(`對帳失敗:${(e as Error).message}`);
    return [] as string[];
  });
  if (reconciled.length > 0) await writeLiveLedger(cfg.ledgerPath, ledger);
  if (news.length === 0) return { opened: 0, skipped };

  let equity: number;
  try {
    equity = (await fetchUsdtBalance(io.creds)).equity;
  } catch (e) {
    await io.notify(`🚨 [實盤] 餘額查詢失敗,本輪全部放棄:${(e as Error).message}`);
    return { opened: 0, skipped: ["餘額查詢失敗"] };
  }

  let opened = 0;
  const tagOf = (o: Opportunity) => `${o.symbol} ${o.dir === "SHORT" ? "做空" : "做多"}`;
  for (const o of news) {
    const key = `${o.symbol}:${o.dir}:${barOpenOf(io.now(), cfg.intervalMs)}`;
    const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
    if (ledger.positions.some((p) => p.key === key)) {
      skipped.push(`${tagOf(o)}:本棒已下過單(冪等)`);
      continue;
    }
    if (opens.some((p) => p.symbol === o.symbol)) {
      skipped.push(`${tagOf(o)}:已有同幣自動倉位`);
      continue;
    }
    if (opens.length >= cfg.maxPositions) {
      skipped.push(`${tagOf(o)}:自動倉位已達上限 ${cfg.maxPositions}`);
      continue;
    }

    try {
      const inst = await fetchInstrument(io.creds, instIdOf(o.symbol));
      const plan = planOrder(o, equity, inst, cfg.riskPct);
      if ("skip" in plan) {
        skipped.push(`${tagOf(o)}:${plan.skip}`);
        await io.notify(`⚠️ [實盤] 放棄 ${tagOf(o)}:${plan.skip}`);
        continue;
      }
      let ordId: string | null = null;
      if (cfg.mode === "real") {
        await setLeverage(io.creds, plan.instId, plan.leverage);
        ordId = await placeMarketWithTpSl(io.creds, {
          instId: plan.instId,
          side: plan.side,
          sz: plan.contracts,
          tpPx: plan.tpPx,
          slPx: plan.slPx,
        });
      }
      const pos: LivePosition = {
        key,
        symbol: o.symbol,
        instId: plan.instId,
        dir: o.dir,
        contracts: plan.contracts,
        entry: o.entry,
        stop: o.stop,
        target: o.target,
        leverage: plan.leverage,
        mode: cfg.mode,
        ordId,
        openedAt: new Date(io.now()).toISOString(),
        status: "OPEN",
      };
      ledger.positions.push(pos);
      opened++;
      const prefix = cfg.mode === "dry" ? "【模擬】" : "";
      await io.notify(
        `${o.dir === "SHORT" ? "🔴" : "🟢"} ${prefix}[實盤] ${tagOf(o)} ${plan.contracts} 張(${plan.leverage}x)\n` +
          `   進場 ~${o.entry} ｜ 停損 ${plan.slPx} ｜ 目標 ${plan.tpPx}\n` +
          `   名目 ${fmtUsdt(plan.notional)} ｜ 保證金 ${fmtUsdt(plan.margin)}${ordId ? ` ｜ 單號 ${ordId}` : ""}`,
      );
    } catch (e) {
      skipped.push(`${tagOf(o)}:下單失敗 ${(e as Error).message}`);
      await io.notify(`🚨 [實盤] ${tagOf(o)} 下單失敗:${(e as Error).message}`);
    }
  }
  await writeLiveLedger(cfg.ledgerPath, ledger);
  return { opened, skipped };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/live.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/live.ts src/live.test.ts
git commit -m "feat: executeLive 實盤協調流程(開關/護欄/冪等/對帳/dry-run)"
```

---

### Task 6: `src/control.ts` — Slack 指令輪詢與路由

**Files:**
- Create: `src/control.ts`
- Test: `src/control.test.ts`

**Interfaces:**
- Consumes: Task 2 `fetchUsdtBalance`/`fetchPositions`/`closePosition`、Task 3 state 函式、Task 5 `LiveConfig`
- Produces:
  - `type ControlCommand = "start"|"stop"|"panic"|"status"|"balance"|"positions"|"report"|"help"`
  - `parseCommand(text: string): ControlCommand | null`(trim 後完全比對)
  - `interface ControlDeps { cfg: LiveConfig; creds: OkxCreds; post(text: string): Promise<void>; runReport(): Promise<void>; nextScanText(): string; slackToken: string; channel: string }`
  - `handleCommand(cmd: ControlCommand, deps: ControlDeps): Promise<string>`(回覆文字;副作用在內)
  - `pollOnce(deps: ControlDeps, lastTs: string): Promise<string>`(處理新訊息,回新 lastTs)
  - `runControlLoop(deps: ControlDeps, intervalMs?: number): Promise<never>`(30s 輪詢,錯誤不退出)

**指令對映(trim 後完全比對):** `啟動自動下單`→start、`停止自動下單`→stop、`緊急平倉`→panic、`狀態`→status、`餘額`→balance、`倉位`→positions、`成績`→report、`指令`→help。

- [ ] **Step 1: 寫失敗測試**

```ts
// src/control.test.ts
import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlDeps, handleCommand, parseCommand, pollOnce } from "./control.js";
import { readControlState, writeControlState, writeLiveLedger } from "./live-state.js";

afterEach(() => {
  mock.restore();
});

async function makeDeps(mode: "dry" | "real" = "real") {
  const dir = await mkdtemp(join(tmpdir(), "ctl-"));
  const posts: string[] = [];
  const deps: ControlDeps = {
    cfg: {
      mode,
      riskPct: 0.01,
      maxPositions: 4,
      ledgerPath: join(dir, "ledger.json"),
      controlPath: join(dir, "control.json"),
      intervalMs: 4 * 3_600_000,
    },
    creds: { apiKey: "k", secret: "s", passphrase: "p" },
    post: async (t) => {
      posts.push(t);
    },
    runReport: mock(async () => {}),
    nextScanText: () => "2026-07-17T08:02:00Z",
    slackToken: "xoxb-test",
    channel: "C123",
  };
  return { dir, deps, posts };
}

describe("parseCommand", () => {
  it("完全比對(含 trim);其他文字回 null", () => {
    expect(parseCommand(" 啟動自動下單 ")).toBe("start");
    expect(parseCommand("停止自動下單")).toBe("stop");
    expect(parseCommand("緊急平倉")).toBe("panic");
    expect(parseCommand("狀態")).toBe("status");
    expect(parseCommand("餘額")).toBe("balance");
    expect(parseCommand("倉位")).toBe("positions");
    expect(parseCommand("成績")).toBe("report");
    expect(parseCommand("指令")).toBe("help");
    expect(parseCommand("啟動")).toBeNull();
    expect(parseCommand("BTCUSDT 4h")).toBeNull();
  });
});

describe("handleCommand", () => {
  it("start/stop 切換開關並持久化", async () => {
    const { dir, deps } = await makeDeps();
    const on = await handleCommand("start", deps);
    expect(on).toContain("✅");
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(true);
    const off = await handleCommand("stop", deps);
    expect(off).toContain("🛑");
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    await rm(dir, { recursive: true });
  });

  it("balance 回權益/可用/未實現", async () => {
    const { dir, deps } = await makeDeps();
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          code: "0", msg: "",
          data: [{ details: [{ ccy: "USDT", eq: "2100.5", availBal: "1800", upl: "15.2" }] }],
        }),
      ),
    ) as unknown as typeof fetch;
    const text = await handleCommand("balance", deps);
    expect(text).toContain("2100.5");
    expect(text).toContain("1800");
    await rm(dir, { recursive: true });
  });

  it("panic:關開關+平掉 ledger 內 real OPEN 倉(不碰非自動倉)", async () => {
    const { dir, deps } = await makeDeps("real");
    await writeControlState(deps.cfg.controlPath, { enabled: true });
    await writeLiveLedger(deps.cfg.ledgerPath, {
      positions: [
        {
          key: "BTCUSDT:SHORT:0", symbol: "BTCUSDT", instId: "BTC-USDT-SWAP", dir: "SHORT",
          contracts: "1", entry: 65000, stop: 67000, target: 62000, leverage: 3,
          mode: "real", ordId: "x", openedAt: "", status: "OPEN",
        },
      ],
    });
    const closeCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/trade/close-position")) {
        closeCalls.push(String(init?.body));
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{}] }));
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data: [] }));
    }) as unknown as typeof fetch;
    const text = await handleCommand("panic", deps);
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    expect(closeCalls.length).toBe(1);
    expect(text).toContain("BTC");
    await rm(dir, { recursive: true });
  });

  it("status 回開關/模式/倉位數/下次掃描", async () => {
    const { dir, deps } = await makeDeps("dry");
    const text = await handleCommand("status", deps);
    expect(text).toContain("dry");
    expect(text).toContain("關閉");
    expect(text).toContain("2026-07-17T08:02:00Z");
    await rm(dir, { recursive: true });
  });

  it("report 觸發 runReport", async () => {
    const { dir, deps } = await makeDeps();
    await handleCommand("report", deps);
    expect((deps.runReport as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    await rm(dir, { recursive: true });
  });
});

describe("pollOnce", () => {
  it("讀新訊息、忽略 bot 訊息、依時序處理、回新 lastTs", async () => {
    const { dir, deps, posts } = await makeDeps();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts: "1700000002.000", text: "停止自動下單", user: "U1" },
              { ts: "1700000001.500", text: "我是機器人", bot_id: "B1" },
              { ts: "1700000001.000", text: "啟動自動下單", user: "U1" },
            ],
          }),
        );
      }
      // chat.postMessage(回覆)
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    const newTs = await pollOnce(deps, "1700000000.000");
    expect(newTs).toBe("1700000002.000");
    // 先啟動後停止 → 最終關閉
    expect((await readControlState(deps.cfg.controlPath)).enabled).toBe(false);
    expect(posts.length).toBe(2); // 兩個指令各回覆一次
    await rm(dir, { recursive: true });
  });

  it("無新訊息:lastTs 不變、不回覆", async () => {
    const { dir, deps, posts } = await makeDeps();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true, messages: [] })),
    ) as unknown as typeof fetch;
    const newTs = await pollOnce(deps, "1700000000.000");
    expect(newTs).toBe("1700000000.000");
    expect(posts.length).toBe(0);
    await rm(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/control.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
// src/control.ts
// Slack 控制迴圈:輪詢控制頻道新訊息 → 指令路由 → 執行 → 回覆。
// 指令採 trim 後完全比對(誤觸風險最低);查詢類唯讀,失敗回錯誤訊息不影響開關。
import {
  closePosition,
  fetchPositions,
  fetchUsdtBalance,
  type OkxCreds,
} from "./okx.js";
import type { LiveConfig } from "./live.js";
import { readControlState, readLiveLedger, writeControlState, writeLiveLedger } from "./live-state.js";

export type ControlCommand =
  | "start"
  | "stop"
  | "panic"
  | "status"
  | "balance"
  | "positions"
  | "report"
  | "help";

const COMMANDS: Record<string, ControlCommand> = {
  啟動自動下單: "start",
  停止自動下單: "stop",
  緊急平倉: "panic",
  狀態: "status",
  餘額: "balance",
  倉位: "positions",
  成績: "report",
  指令: "help",
};

export function parseCommand(text: string): ControlCommand | null {
  return COMMANDS[text.trim()] ?? null;
}

export interface ControlDeps {
  cfg: LiveConfig;
  creds: OkxCreds;
  post(text: string): Promise<void>; // 回覆到控制頻道
  runReport(): Promise<void>; // 「成績」:觸發 4h 成績單推播
  nextScanText(): string; // 「狀態」:下次掃描時間
  slackToken: string;
  channel: string;
}

const HELP_TEXT = [
  "可用指令(輸入完整字串):",
  "• 啟動自動下單 — 開啟訊號自動下單",
  "• 停止自動下單 — 停開新倉(既有倉交給交易所 TP/SL)",
  "• 緊急平倉 — 停止並市價平掉所有自動倉位",
  "• 狀態 — 開關/模式/倉位數/下次掃描",
  "• 餘額 — USDT 權益/可用/未實現",
  "• 倉位 — 目前合約倉位(標註自動/手動)",
  "• 成績 — 立即推 4h 紙上成績單",
  "• 指令 — 本清單",
].join("\n");

export async function handleCommand(cmd: ControlCommand, deps: ControlDeps): Promise<string> {
  const { cfg, creds } = deps;
  switch (cmd) {
    case "start": {
      await writeControlState(cfg.controlPath, { enabled: true });
      return `✅ 已啟動自動下單(模式:${cfg.mode})`;
    }
    case "stop": {
      await writeControlState(cfg.controlPath, { enabled: false });
      return "🛑 已停止自動下單;既有倉位由交易所 TP/SL 管理";
    }
    case "panic": {
      await writeControlState(cfg.controlPath, { enabled: false });
      const ledger = await readLiveLedger(cfg.ledgerPath);
      const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
      if (opens.length === 0) return "🛑 已停止;沒有自動倉位需要平倉";
      const lines: string[] = [];
      for (const p of opens) {
        try {
          if (cfg.mode === "real") await closePosition(creds, p.instId);
          p.status = "CLOSED";
          p.closedAt = new Date().toISOString();
          p.closeReason = cfg.mode === "real" ? "緊急平倉" : "【模擬】緊急平倉";
          lines.push(`✅ ${p.symbol} 已平倉`);
        } catch (e) {
          lines.push(`🚨 ${p.symbol} 平倉失敗:${(e as Error).message}(請手動處理)`);
        }
      }
      await writeLiveLedger(cfg.ledgerPath, ledger);
      return [`🛑 緊急平倉(${cfg.mode}):`, ...lines].join("\n");
    }
    case "status": {
      const control = await readControlState(cfg.controlPath);
      const ledger = await readLiveLedger(cfg.ledgerPath);
      const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
      return (
        `⚙️ 自動下單:${control.enabled ? "開啟" : "關閉"}｜模式:${cfg.mode}\n` +
        `自動倉位 ${opens.length}/${cfg.maxPositions}${opens.length ? `(${opens.map((p) => p.symbol).join("、")})` : ""}\n` +
        `下次掃描:${deps.nextScanText()}`
      );
    }
    case "balance": {
      const b = await fetchUsdtBalance(creds);
      const sign = b.unrealizedPnl >= 0 ? "+" : "";
      return `💰 USDT 權益 ${b.equity}｜可用 ${b.available}｜未實現 ${sign}${b.unrealizedPnl}`;
    }
    case "positions": {
      const [ps, ledger] = await Promise.all([
        fetchPositions(creds),
        readLiveLedger(cfg.ledgerPath),
      ]);
      if (ps.length === 0) return "目前沒有合約倉位";
      const auto = new Set(
        ledger.positions.filter((p) => p.status === "OPEN").map((p) => p.instId),
      );
      const lines = ps.map((p) => {
        const dir = p.pos > 0 ? "🟢 做多" : "🔴 做空";
        const pnl = `${p.upl >= 0 ? "+" : ""}${p.upl.toFixed(1)} USDT(${(p.uplRatio * 100).toFixed(1)}%)`;
        const tag = auto.has(p.instId) ? "自動" : "手動";
        return `${dir} ${p.instId} ×${Math.abs(p.pos)}(${p.lever}x,${tag})\n   均價 ${p.avgPx} ｜ 標記 ${p.markPx} ｜ 未實現 ${pnl}`;
      });
      return lines.join("\n");
    }
    case "report": {
      await deps.runReport();
      return "📊 已觸發 4h 紙上成績單推播";
    }
    case "help":
      return HELP_TEXT;
  }
}

interface SlackMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

// 讀 lastTs 之後的新訊息(排除 bot/系統訊息),依時間舊到新逐一處理;回傳新的 lastTs。
export async function pollOnce(deps: ControlDeps, lastTs: string): Promise<string> {
  const url =
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(deps.channel)}` +
    `&oldest=${encodeURIComponent(lastTs)}&inclusive=false&limit=20`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${deps.slackToken}` },
  });
  const data = (await resp.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
  if (!data.ok) throw new Error(`Slack 讀取失敗:${data.error ?? "unknown"}`);
  const msgs = (data.messages ?? [])
    .filter((m) => !m.bot_id && !m.subtype && m.text)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  let newLast = lastTs;
  for (const m of data.messages ?? []) {
    if (Number(m.ts) > Number(newLast)) newLast = m.ts;
  }
  for (const m of msgs) {
    const cmd = parseCommand(m.text ?? "");
    if (!cmd) continue; // 非指令文字直接忽略(頻道可能有人聊天)
    let reply: string;
    try {
      reply = await handleCommand(cmd, deps);
    } catch (e) {
      reply = `🚨 指令執行失敗:${(e as Error).message}`;
    }
    await deps.post(reply);
  }
  return newLast;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 常駐控制迴圈:每 intervalMs 輪詢一次;單輪錯誤只記 log,迴圈不退出。
// 起始 lastTs = 現在(不重播啟動前的歷史指令)。
export async function runControlLoop(deps: ControlDeps, intervalMs = 30_000): Promise<never> {
  let lastTs = (Date.now() / 1000).toFixed(6);
  while (true) {
    try {
      lastTs = await pollOnce(deps, lastTs);
    } catch (e) {
      console.error(`[控制迴圈] ${(e as Error).message}`);
    }
    await sleep(intervalMs);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/control.test.ts && bun run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/control.ts src/control.test.ts
git commit -m "feat: Slack 控制指令(啟動/停止/緊急平倉/狀態/餘額/倉位/成績)"
```

---

### Task 7: 策略旗標 + `scripts/detect.ts` 接上實盤

**Files:**
- Modify: `src/strategies.ts`(`Strategy` 加 `liveTrading: boolean`;4h `true`、1h `false`)
- Modify: `scripts/detect.ts`(紙上記帳之後接 `executeLive`)
- Test: `src/strategies.test.ts`(追加一條斷言)

**Interfaces:**
- Consumes: Task 5 `executeLive`/`liveConfigFromEnv`、`credsFromEnv`(Task 1)、`fetchLastPrice`(`src/bybit.ts`)、`postMessage`(`src/slack.ts`)
- Produces: 無新介面(整合)

- [ ] **Step 1: 改 `src/strategies.ts`**

`Strategy` interface 加欄位(有註解):

```ts
  liveTrading: boolean; // 是否把新機會接到 OKX 實盤下單(仍受 Slack 開關與 LIVE_MODE 控制)
```

4h 設 `liveTrading: true`,1h 設 `liveTrading: false`。

- [ ] **Step 2: `src/strategies.test.ts` 追加斷言**

```ts
test("只有 4h 開實盤下單", () => {
  expect(strategyByName("4h").liveTrading).toBe(true);
  expect(strategyByName("1h").liveTrading).toBe(false);
});
```

Run: `bun test src/strategies.test.ts` → PASS

- [ ] **Step 3: `scripts/detect.ts` 整合(加在紙上交易區塊之後、`}` 之前)**

```ts
  // 實盤下單:只有 liveTrading 策略;開關/護欄/dry-run 都在 executeLive 內處理。
  // 任何錯誤不影響訊號推播與紙上記帳(executeLive 內部已逐筆告警,這裡是最後防線)。
  if (strategy.liveTrading) {
    try {
      const cfg = liveConfigFromEnv(intervalMsOf(strategy.interval));
      const controlChannel = process.env.SLACK_CONTROL_CHANNEL_ID;
      const res = await executeLive(news, cfg, {
        creds: credsFromEnv(),
        notify: (text) => postMessage(text, controlChannel),
        lastPrice: (sym) => fetchLastPrice("futures", sym),
        now: () => Date.now(),
      });
      console.log(
        `${tag} [實盤] 開倉 ${res.opened} 筆${res.skipped.length ? `、跳過:${res.skipped.join(";")}` : ""}`,
      );
    } catch (e) {
      console.error(`${tag} [實盤] 執行失敗:${(e as Error).message}`);
    }
  }
```

對應 import(檔頭):

```ts
import { fetchLastPrice } from "../src/bybit.js"; // 併入既有 bybit import
import { executeLive, liveConfigFromEnv } from "../src/live.js";
import { credsFromEnv } from "../src/okx.js";
```

注意:`credsFromEnv()` 在缺 OKX env 時會拋錯 → 被外層 catch 吃掉只記 log,**未設定 OKX 的部署完全不受影響**。

- [ ] **Step 4: 跑全測試 + check**

Run: `bun test && bun run check`
Expected: 全綠(既有 detect 相關測試不受影響——`LIVE` 環境變數未設時走 dry + 開關檔不存在 = 關閉,不打 API)

- [ ] **Step 5: Commit**

```bash
git add src/strategies.ts src/strategies.test.ts scripts/detect.ts
git commit -m "feat: detect.ts 接上實盤下單(僅 4h,受開關/LIVE_MODE 控制)"
```

---

### Task 8: `scripts/scheduler.ts` — 控制迴圈與啟動宣告

**Files:**
- Modify: `scripts/scheduler.ts`

**Interfaces:**
- Consumes: Task 6 `runControlLoop`/`ControlDeps`、Task 5 `liveConfigFromEnv`、Task 1 `credsFromEnv`、`postMessage`(`src/slack.ts`)、`nextRunTime`(`src/schedule.ts`)

- [ ] **Step 1: 在主迴圈(`while (true)`)之前加入控制迴圈啟動**

```ts
import { runControlLoop } from "../src/control.js";
import { liveConfigFromEnv } from "../src/live.js";
import { readControlState } from "../src/live-state.js";
import { credsFromEnv } from "../src/okx.js";
import { intervalMsOf } from "../src/strategies.js"; // 併入既有 import
import { postMessage } from "../src/slack.js";
import { nextRunTime } from "../src/schedule.js"; // 併入既有 import

// ── Slack 控制迴圈(實盤開關/查詢)──────────────────────
// 需要 SLACK_BOT_TOKEN + SLACK_CONTROL_CHANNEL_ID + OKX 憑證;缺任一則停用(純推播部署不受影響)。
const controlChannel = process.env.SLACK_CONTROL_CHANNEL_ID;
const slackToken = process.env.SLACK_BOT_TOKEN;
if (controlChannel && slackToken && process.env.OKX_API_KEY) {
  const cfg = liveConfigFromEnv(intervalMsOf("4h"));
  const deps = {
    cfg,
    creds: credsFromEnv(),
    post: (text: string) => postMessage(text, controlChannel),
    runReport: async () => {
      await runScript(["scripts/paper-report.ts", "4h"]);
    },
    nextScanText: () => nextRunTime(new Date(), RUN_HOURS, RUN_MINUTE).toISOString(),
    slackToken,
    channel: controlChannel,
  };
  // 啟動宣告:重啟後告知目前開關狀態,避免以為還開著/關著。
  const state = await readControlState(cfg.controlPath);
  await postMessage(
    `♻️ 排程器已啟動。自動下單:${state.enabled ? "開啟" : "關閉"}(模式:${cfg.mode})\n輸入「指令」查看可用操作`,
    controlChannel,
  ).catch((e) => console.error(`啟動宣告失敗:${(e as Error).message}`));
  void runControlLoop(deps);
  console.log("[控制迴圈] 已啟動(每 30 秒輪詢 Slack 控制頻道)");
} else {
  console.log("[控制迴圈] 未設定 SLACK_CONTROL_CHANNEL_ID/OKX 憑證,實盤控制停用");
}
```

(放在既有 `runScript` 定義之後、`while (true)` 之前。)

- [ ] **Step 2: 手動驗證(不打真 API)**

Run: `SCAN_EVERY_SECONDS=3600 bun scripts/scheduler.ts` 跑 5 秒後 Ctrl-C
Expected: 印出「[控制迴圈] 未設定 …,實盤控制停用」(本機殼層無 OKX env 時),排程器照常啟動

- [ ] **Step 3: 跑全測試 + check**

Run: `bun test && bun run check`
Expected: 全綠

- [ ] **Step 4: Commit**

```bash
git add scripts/scheduler.ts
git commit -m "feat: 排程器並行 Slack 控制迴圈與重啟宣告"
```

---

### Task 9: 環境變數範例、文件、收尾驗證

**Files:**
- Modify: `.env.local.example`
- Modify: `CLAUDE.md`(Architecture 段落補一句)
- Modify: `docker/docker-compose.yml`(容器內帳本路徑)

- [ ] **Step 1: `.env.local.example` 追加**

```bash
# ── 實盤自動下單(OKX)────────────────────────────────
# 三者齊備才會啟用;OKX API key 權限只開「讀取+交易」,不開提幣。
OKX_API_KEY=
OKX_API_SECRET=
OKX_API_PASSPHRASE=
# Slack 控制頻道(啟動/停止/查詢指令;bot 需加 channels:history scope 並邀入頻道)
SLACK_CONTROL_CHANNEL_ID=
# dry(預設,只模擬與通報,不真下單)/ real(真金白銀)
LIVE_MODE=dry
# 自動倉位上限(預設 4)
# LIVE_MAX_POSITIONS=4
```

- [ ] **Step 2: `docker/docker-compose.yml` environment 追加兩行**

```yaml
      - LIVE_LEDGER_PATH=/app/data/live-ledger.json
      - LIVE_CONTROL_PATH=/app/data/live-control.json
```

- [ ] **Step 3: `CLAUDE.md` Architecture 段落尾端補充**

在 Testing model 段落前加:

```markdown
### 實盤自動下單(OKX)

4h 策略新機會可接 OKX 真實下單(`src/okx.ts` 零相依 v5 client、`src/live.ts` 協調、
`src/control.ts` Slack 指令)。三重防護:Slack 開關(`./data/live-control.json`,fail-closed)、
`LIVE_MODE=dry|real`(預設 dry)、逐筆護欄(同幣去重/倉位上限/冪等鍵)。出場靠下單時的
attached TP/SL(交易所端),排程器掛掉不影響保護。`緊急平倉`只平 live ledger 內的自動倉位。
OKX MCP 不參與自動化,僅供對話中手動查倉/干預。
```

- [ ] **Step 4: 全面驗證**

Run: `bun test && bun run check && bunx wrangler deploy --dry-run`
Expected: 全綠;wrangler dry-run 通過(Worker 不 import 任何新模組,bundle 不變)

- [ ] **Step 5: Commit**

```bash
git add .env.local.example docker/docker-compose.yml CLAUDE.md
git commit -m "docs: 實盤自動下單環境變數與架構說明"
```

---

## 上線 Runbook(實作完成後,人工操作)

1. OKX 建 API key(權限:讀取+交易,**不開提幣**;綁定 IP 更佳),填入 `.env.local`。
2. Slack App 加 `channels:history` scope → reinstall → 把 bot 邀進控制頻道,填 `SLACK_CONTROL_CHANNEL_ID`。
3. 確認 OKX 帳戶為**買賣模式(net mode)**、有 USDT 於交易帳戶。
4. `make rebuild` 重啟排程器 → Slack 應收到重啟宣告。
5. 傳「指令」「狀態」「餘額」驗證查詢;傳「啟動自動下單」→ dry-run 跑一週,核對每筆【模擬】通報的張數/TP/SL。
6. 滿意後 `.env.local` 改 `LIVE_MODE=real`、`make rebuild`,清掉或改名 dry 帳本(`data/live-ledger.json`),重新「啟動自動下單」。首倉人工對照 OKX App。
