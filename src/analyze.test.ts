import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleText } from "./analyze.js";

// 產生 OKX 格式的假 K 線(newest-first),trend 控制漲跌。
function fakeOKXCandles(n: number, trend: number): string[][] {
  const rows: string[][] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += trend + Math.sin(i / 7) * 0.3;
    const close = price;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const ts = 1_700_000_000_000 + i * 3_600_000;
    rows.push([String(ts), String(open), String(high), String(low), String(close), "1000"]);
  }
  return rows.reverse();
}

function mockFetch(trend: number) {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("/market/candles")) {
      return new Response(JSON.stringify({ code: "0", msg: "", data: fakeOKXCandles(300, trend) }));
    }
    if (url.includes("/funding-rate")) {
      return new Response(JSON.stringify({ code: "0", data: [{ fundingRate: "0.0001" }] }));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

afterEach(() => mock.restore());

describe("handleText", () => {
  test("上升趨勢 → 做多 Flex 圖卡 + quick reply", async () => {
    mockFetch(0.6);
    const [msg] = await handleText("btc 1h 10x");
    const blob = JSON.stringify(msg);
    expect(msg.type).toBe("flex");
    expect(blob).toContain("BTCUSDT");
    expect(blob).toContain("做多");
    expect(blob).toContain("停損");
    expect(blob).toContain("槓桿 10×");
    const labels = msg.quickReply?.items.map((i) => i.action.label) ?? [];
    expect(labels).toContain("4h");
    expect(labels).toContain("多週期");
  });

  test("下降趨勢 → 做空", async () => {
    mockFetch(-0.6);
    const [msg] = await handleText("btc");
    expect(JSON.stringify(msg)).toContain("做空");
  });

  test("不再顯示免責聲明", async () => {
    mockFetch(0.6);
    const [msg] = await handleText("btc");
    expect(JSON.stringify(msg)).not.toContain("非投資建議");
  });

  test("multi → carousel(多張 bubble)", async () => {
    mockFetch(0.6);
    const [msg] = await handleText("btc multi");
    expect(msg.type).toBe("flex");
    const contents = (msg as unknown as { contents: { type: string; contents: unknown[] } })
      .contents;
    expect(contents.type).toBe("carousel");
    expect(contents.contents.length).toBe(3);
  });

  test("help 回使用說明 + 幣別按鈕", async () => {
    const [msg] = await handleText("help");
    expect(msg.type).toBe("text");
    expect((msg as { text: string }).text).toContain("加密貨幣訊號機器人");
    expect(msg.quickReply?.items.map((i) => i.action.label)).toContain("BTC");
  });
});
