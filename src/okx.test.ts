import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchKlines, fetchLastPrice } from "./okx.js";

afterEach(() => mock.restore());

// OKX K 棒列(newest-first):[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
function candle(ts: number, confirm: "0" | "1"): string[] {
  return [String(ts), "100", "101", "99", "100.5", "1000", "0", "0", confirm];
}

function mockCandles(rows: string[][]) {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("/market/candles"))
      return new Response(JSON.stringify({ code: "0", msg: "", data: rows }));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("fetchKlines 未收盤棒處理", () => {
  test("confirm=0 → 丟棄最新、回傳由舊到新且不含未收盤根", async () => {
    const rows = [candle(5000, "0"), candle(4000, "1"), candle(3000, "1"), candle(2000, "1")];
    mockCandles(rows);
    const out = await fetchKlines("futures", "BTCUSDT", "4h", 4);
    expect(out.length).toBe(3); // 丟掉未收盤那根
    expect(out[out.length - 1].openTime).toBe(4000); // 最新變成已收盤的 4000
    expect(out.map((k) => k.openTime)).toEqual([2000, 3000, 4000]); // 由舊到新
  });

  test("最新一根 confirm=1(已收盤)→ 全部保留", async () => {
    const rows = [candle(5000, "1"), candle(4000, "1"), candle(3000, "1")];
    mockCandles(rows);
    const out = await fetchKlines("futures", "BTCUSDT", "4h", 3);
    expect(out.length).toBe(3);
    expect(out[out.length - 1].openTime).toBe(5000);
  });

  test("無 confirm 欄位(如測試樁)→ 不丟棄", async () => {
    const rows = [
      ["5000", "100", "101", "99", "100", "1000"],
      ["4000", "100", "101", "99", "100", "1000"],
    ];
    mockCandles(rows);
    const out = await fetchKlines("futures", "BTCUSDT", "4h", 2);
    expect(out.length).toBe(2);
  });
});

describe("fetchLastPrice", () => {
  test("回傳 ticker 的 last 價", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/market/ticker"))
        return new Response(JSON.stringify({ code: "0", msg: "", data: [{ last: "12345.6" }] }));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await fetchLastPrice("futures", "BTCUSDT")).toBe(12345.6);
  });

  test("失敗時回 null(不拋例外)", async () => {
    globalThis.fetch = mock(
      async () => new Response("err", { status: 500 }),
    ) as unknown as typeof fetch;
    expect(await fetchLastPrice("futures", "BTCUSDT")).toBeNull();
  });
});
