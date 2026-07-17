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
