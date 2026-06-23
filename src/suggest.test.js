import { afterEach, describe, expect, mock, test } from "bun:test";
import { editDistance, suggestSymbols, toBase } from "./suggest.js";

const SWAP_BASES = ["BTC", "ETH", "QTUM", "QNT", "QI", "DOGE", "DOT", "AAVE"];

function mockInstruments() {
  globalThis.fetch = mock(async (url) => {
    if (url.includes("/public/instruments")) {
      return new Response(
        JSON.stringify({ code: "0", data: SWAP_BASES.map((b) => ({ instId: `${b}-USDT-SWAP` })) }),
      );
    }
    return new Response("not found", { status: 404 });
  });
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
    expect(out).toContain("QI"); // 距離 1
    expect(out).toContain("QNT"); // 距離 2
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
