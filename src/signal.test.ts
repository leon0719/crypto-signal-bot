import { describe, expect, test } from "bun:test";
import { build, defaultConfig } from "./signal.js";
import type { Kline } from "./types.js";

// 產生 n 根、每根 +pct 的等比上升 K 線(量能遞增以過量能過濾)。
export function uptrend(n: number, pct = 0.01, start = 100): Kline[] {
  const out: Kline[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + pct;
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

describe("defaultConfig 新增開關預設關閉", () => {
  test("三個增強開關預設 false、含新參數與影線權重", () => {
    const c = defaultConfig();
    expect(c.srFilter).toBe(false);
    expect(c.slopeFilter).toBe(false);
    expect(c.shadowComp).toBe(false);
    expect(c.srSpan).toBe(5);
    expect(c.srBufferATR).toBe(0.5);
    expect(c.slopeLookback).toBe(5);
    expect(c.slopeDiscount).toBe(0.5);
    expect(c.weights.shadow).toBe(0.5);
  });
});

describe("build 回傳 high/low 陣列", () => {
  test("high/low 與輸入等長且對齊", () => {
    const kl = uptrend(60);
    const ind = build(kl, defaultConfig());
    expect(ind.high.length).toBe(60);
    expect(ind.low.length).toBe(60);
    expect(ind.high[10]).toBe(kl[10].high);
    expect(ind.low[10]).toBe(kl[10].low);
  });
});
