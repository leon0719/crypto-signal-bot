import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleText } from "./analyze.js";
import { parseCommand } from "./command.js";

// 產生 OKX 格式的假 K 線(newest-first),trend 控制漲跌。
function fakeOKXCandles(n, trend) {
  const rows = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += trend + Math.sin(i / 7) * 0.3; // 帶點波動的趨勢
    const close = price;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const ts = 1_700_000_000_000 + i * 3_600_000;
    rows.push([String(ts), String(open), String(high), String(low), String(close), "1000"]);
  }
  return rows.reverse(); // OKX 回傳新到舊
}

function mockFetch(trend) {
  globalThis.fetch = mock(async (url) => {
    if (url.includes("/market/candles")) {
      return new Response(JSON.stringify({ code: "0", msg: "", data: fakeOKXCandles(300, trend) }));
    }
    if (url.includes("/funding-rate")) {
      return new Response(JSON.stringify({ data: [{ fundingRate: "0.0001" }] }));
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => mock.restore());

describe("parseCommand", () => {
  test("純幣別補上 USDT、預設合約 1h", () => {
    expect(parseCommand("btc")).toMatchObject({
      symbol: "BTCUSDT",
      interval: "1h",
      market: "futures",
      leverage: 1,
    });
  });

  test("解析週期、槓桿、現貨", () => {
    expect(parseCommand("eth 4h 10x spot")).toMatchObject({
      symbol: "ETHUSDT",
      interval: "4h",
      market: "spot",
      leverage: 10,
    });
  });

  test("help 觸發", () => {
    expect(parseCommand("幫助").help).toBe(true);
    expect(parseCommand("").help).toBe(true);
  });
});

describe("handleText", () => {
  test("上升趨勢 → 做多訊號", async () => {
    mockFetch(0.6);
    const reply = await handleText("btc 1h 10x");
    expect(reply).toContain("BTCUSDT");
    expect(reply).toContain("做多");
    expect(reply).toContain("停損");
    expect(reply).toContain("槓桿 10×");
  });

  test("下降趨勢 → 做空訊號", async () => {
    mockFetch(-0.6);
    const reply = await handleText("btc");
    expect(reply).toContain("做空");
  });

  test("help 回使用說明", async () => {
    const reply = await handleText("help");
    expect(reply).toContain("加密貨幣訊號機器人");
  });
});
