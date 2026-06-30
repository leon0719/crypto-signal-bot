import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearBasesCache } from "./bybit.js";
import { editDistance, suggestSymbols, toBase } from "./suggest.js";

const SWAP_BASES = ["BTC", "ETH", "QTUM", "QNT", "QI", "DOGE", "DOT", "AAVE"];

beforeEach(() => clearBasesCache()); // 清掉跨測試汙染的幣種快取

function mockInstruments() {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("/instruments-info")) {
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: {
            list: SWAP_BASES.map((b) => ({ baseCoin: b, quoteCoin: "USDT", status: "Trading" })),
          },
        }),
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

afterEach(() => mock.restore());

describe("toBase", () => {
  test("去掉計價與符號", () => {
    expect(toBase("BTCUSDT")).toBe("BTC");
    expect(toBase("eth-usdt")).toBe("ETH");
  });
});

describe("editDistance", () => {
  test("基本距離", () => {
    expect(editDistance("BTC", "BTC")).toBe(0);
    expect(editDistance("BTV", "BTC")).toBe(1);
  });
});

describe("suggestSymbols", () => {
  test("QA → 推薦相近的 Q 開頭幣", async () => {
    mockInstruments();
    const out = await suggestSymbols("futures", "QAUSDT", 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("QI");
    expect(out).toContain("QNT");
  });

  test("typo DOGEE → DOGE", async () => {
    mockInstruments();
    const out = await suggestSymbols("futures", "DOGEE", 5);
    expect(out[0]).toBe("DOGE");
  });

  test("完全不相關 → 空陣列", async () => {
    mockInstruments();
    const out = await suggestSymbols("futures", "ZZZZZZ", 5);
    expect(out).toHaveLength(0);
  });
});
