import { describe, expect, test } from "bun:test";
import { build, defaultConfig, evalAt } from "./signal.js";
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

describe("K 棒影線加權項(shadowComp)", () => {
  function seriesWithUpperShadow(): Kline[] {
    const kl = uptrend(60);
    const last = kl[kl.length - 1];
    // 把最後一根改成長上影線:收盤壓回、上影拉長。
    last.high = last.close * 1.03;
    last.low = last.open * 0.999;
    last.close = last.open * 1.001; // 收在低位
    return kl;
  }

  test("關閉時 components 無影線項", () => {
    const kl = seriesWithUpperShadow();
    const ind = build(kl, defaultConfig());
    const r = evalAt(ind, kl.length - 1);
    expect(r?.components.some((c) => c.name === "K棒影線")).toBe(false);
  });

  test("開啟時長上影線產生偏空(負值)影線項", () => {
    const kl = seriesWithUpperShadow();
    const cfg = { ...defaultConfig(), shadowComp: true };
    const ind = build(kl, cfg);
    const r = evalAt(ind, kl.length - 1);
    const comp = r?.components.find((c) => c.name === "K棒影線");
    expect(comp).toBeDefined();
    expect((comp as { value: number }).value).toBeLessThan(0);
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
