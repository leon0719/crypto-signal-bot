import { describe, expect, test } from "bun:test";
import { buildFlexMessage } from "./format.js";
import { build, defaultConfig, evalAt } from "./signal.js";
import { type AnalyzeCommand, Direction, type HtfInfo, type Kline, type Result } from "./types.js";

// 造一段穩定上升趨勢,讓末根產生明確做多訊號。
function uptrend(n: number): Kline[] {
  const out: Kline[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1.01;
    const close = price;
    out.push({
      openTime: i * 3600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + i,
    });
  }
  return out;
}

const meta: AnalyzeCommand = {
  help: false,
  symbol: "BTCUSDT",
  interval: "4h",
  market: "futures",
  leverage: 1,
};

function longSetup(): { ind: ReturnType<typeof build>; res: Result } {
  const cfg = { ...defaultConfig(), volumeFilter: false };
  const ind = build(uptrend(300), cfg);
  const res = evalAt(ind, ind.klines.length - 1);
  if (!res) throw new Error("測試資料應產生有效訊號");
  return { ind, res };
}

// buildFlexMessage 必回 flex 訊息,收斂型別以便讀 altText/contents。
function asFlex(m: ReturnType<typeof buildFlexMessage>): { altText: string; contents: unknown } {
  return m as unknown as { altText: string; contents: unknown };
}

describe("buildFlexMessage 大週期確認", () => {
  test("大週期一致 → 維持做多(方向、altText)", () => {
    const { ind, res } = longSetup();
    expect(res.direction).toBe(Direction.Long);
    const htf: HtfInfo = { interval: "1d", score: 40, conflict: false };
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf));
    expect(msg.altText).toContain("做多");
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("方向一致 ✓");
    // 出場指引改為 2×ATR 移動停損(做多 → 波段高點 − 2×ATR)。
    expect(blob).toContain("移動停損");
    expect(blob).toContain("波段高點 − 2×ATR");
  });

  test("大週期牴觸 → 整張卡降級觀望(標題與 altText 不再顯示做多)", () => {
    const { ind, res } = longSetup();
    const htf: HtfInfo = { interval: "1d", score: -40, conflict: true };
    const msg = asFlex(buildFlexMessage(meta, ind, res, htf));
    // altText 與標題方向都應為觀望,而非做多。
    expect(msg.altText).toContain("觀望");
    expect(msg.altText).not.toContain("做多");
    const blob = JSON.stringify(msg.contents);
    expect(blob).toContain("觀望");
    expect(blob).toContain("方向牴觸 ✗");
    expect(blob).toContain("不建議逆勢進場");
    // 衝突時不應再出現交易規劃。
    expect(blob).not.toContain("交易規劃");
  });
});
