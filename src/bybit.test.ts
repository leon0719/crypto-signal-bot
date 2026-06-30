import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchKlines, fetchLastPrice } from "./bybit.js";

afterEach(() => mock.restore());

// Bybit kline 列(newest-first):[start, open, high, low, close, volume, turnover]
function candle(ts: number): string[] {
  return [String(ts), "100", "101", "99", "100.5", "1000", "100500"];
}

function mockKline(rows: string[][]) {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("/market/kline"))
      return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: rows } }));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const HOUR = 3_600_000;

describe("fetchKlines 未收盤棒處理", () => {
  test("最新一根仍在形成(收盤時點未到)→ 丟棄、回傳由舊到新", async () => {
    // 最新一根 openTime = 現在,4h 後才收盤 → 仍在形成 → 丟棄。
    const now = Date.now();
    const rows = [
      candle(now), // 形成中
      candle(now - 4 * HOUR),
      candle(now - 8 * HOUR),
      candle(now - 12 * HOUR),
    ];
    mockKline(rows);
    const out = await fetchKlines("futures", "BTCUSDT", "4h", 4);
    expect(out.length).toBe(3); // 丟掉未收盤那根
    expect(out[out.length - 1].openTime).toBe(now - 4 * HOUR); // 最新變成已收盤的那根
    expect(out.map((k) => k.openTime)).toEqual([now - 12 * HOUR, now - 8 * HOUR, now - 4 * HOUR]);
  });

  test("最新一根已收盤(收盤時點已過)→ 全部保留", async () => {
    const base = Date.now() - 100 * HOUR; // 全部都在過去
    const rows = [candle(base), candle(base - 4 * HOUR), candle(base - 8 * HOUR)];
    mockKline(rows);
    const out = await fetchKlines("futures", "BTCUSDT", "4h", 3);
    expect(out.length).toBe(3);
    expect(out[out.length - 1].openTime).toBe(base);
  });
});

describe("fetchLastPrice", () => {
  test("回傳 ticker 的 lastPrice", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/market/tickers"))
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: "OK",
            result: { list: [{ lastPrice: "12345.6" }] },
          }),
        );
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
