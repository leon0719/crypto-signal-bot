// src/risk.test.ts
import { describe, expect, test } from "bun:test";
import { suggestLeverage } from "./risk.js";

describe("suggestLeverage:ATR% 分檔", () => {
  test("低波動 ≤1% → 5x(含邊界)", () => {
    expect(suggestLeverage(0.5, 100)).toBe(5); // 0.5%
    expect(suggestLeverage(1, 100)).toBe(5); // 恰 1%
  });
  test("1–1.5% → 4x(含邊界 1.5)", () => {
    expect(suggestLeverage(1.2, 100)).toBe(4);
    expect(suggestLeverage(1.5, 100)).toBe(4);
  });
  test("1.5–2% → 3x(含邊界 2)", () => {
    expect(suggestLeverage(1.8, 100)).toBe(3);
    expect(suggestLeverage(2, 100)).toBe(3);
  });
  test("2–3% → 2x(含邊界 3)", () => {
    expect(suggestLeverage(2.5, 100)).toBe(2);
    expect(suggestLeverage(3, 100)).toBe(2);
  });
  test("高波動 >3% → 1x", () => {
    expect(suggestLeverage(3.01, 100)).toBe(1);
    expect(suggestLeverage(10, 100)).toBe(1);
  });
  test("無效輸入一律保守 1x", () => {
    expect(suggestLeverage(Number.NaN, 100)).toBe(1);
    expect(suggestLeverage(1, Number.NaN)).toBe(1);
    expect(suggestLeverage(0, 100)).toBe(1);
    expect(suggestLeverage(-1, 100)).toBe(1);
    expect(suggestLeverage(1, 0)).toBe(1);
  });
});
