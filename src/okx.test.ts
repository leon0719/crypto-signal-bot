import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  closePosition,
  fetchInstrument,
  fetchPositions,
  fetchUsdtBalance,
  instIdOf,
  OkxError,
  okxRequest,
  placeMarketWithTpSl,
  sign,
} from "./okx.js";

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
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            code: "1",
            msg: "op fail",
            data: [{ sCode: "51008", sMsg: "餘額不足" }],
          }),
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

  it("placeMarketWithTpSl:外層 code=0 但單筆 sCode 非 0 → 拋 OkxError(fail-closed)", async () => {
    stubOkx({ "/trade/order": [{ ordId: "", sCode: "51008", sMsg: "餘額不足" }] });
    await expect(
      placeMarketWithTpSl(CREDS, {
        instId: "BTC-USDT-SWAP",
        side: "buy",
        sz: "1",
        tpPx: "1",
        slPx: "2",
      }),
    ).rejects.toThrow(OkxError);
  });

  it("fetchPositions 過濾掉 pos=0 並轉數字", async () => {
    stubOkx({
      "/account/positions": [
        {
          instId: "BTC-USDT-SWAP",
          pos: "-2",
          avgPx: "65000",
          markPx: "64000",
          upl: "20",
          uplRatio: "0.05",
          lever: "3",
        },
        {
          instId: "ETH-USDT-SWAP",
          pos: "0",
          avgPx: "",
          markPx: "",
          upl: "",
          uplRatio: "",
          lever: "",
        },
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
