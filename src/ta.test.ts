import { describe, expect, test } from "bun:test";
import { nearestSR, shadowScore, slopeSign, swingPoints } from "./ta.js";

describe("swingPoints", () => {
  test("找出轉折高低點(左右各 span 根確認)", () => {
    // 索引:    0  1  2   3  4  5  6
    const high = [0, 1, 2, 10, 2, 1, 0];
    const low = [9, 8, 7, 1, 7, 8, 9];
    const { highs, lows } = swingPoints(high, low, 2);
    expect(highs).toEqual([10]); // i=3 的 high 嚴格高於左右各 2 根
    expect(lows).toEqual([1]); // i=3 的 low 嚴格低於左右各 2 根
  });

  test("最後 span 根因缺右側確認不計入", () => {
    // 真正的峰落在最後一根,無右側資料 → 不該被當 swing high。
    const high = [1, 2, 3, 4, 9];
    const low = [9, 8, 7, 6, 1];
    const { highs, lows } = swingPoints(high, low, 2);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });

  test("span < 1 回傳空陣列", () => {
    const { highs, lows } = swingPoints([1, 2, 3], [3, 2, 1], 0);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });

  test("平台(相等值)不算嚴格轉折", () => {
    const flat = [5, 5, 5, 5, 5];
    const { highs, lows } = swingPoints(flat, flat, 1);
    expect(highs).toEqual([]);
    expect(lows).toEqual([]);
  });
});

describe("nearestSR", () => {
  // span=2。已確認的 swing high 在 center 3(=20)與 center 6(=30);swing low 在 center 3(=1)與 center 6(=2)。
  // 兩個轉折點相距 3 根(> span),彼此不互相否定,故都成立。
  const high = [10, 11, 12, 20, 13, 14, 30, 15, 12, 16];
  const low = [5, 4, 3, 1, 6, 7, 2, 8, 9, 4];

  test("上方取最近壓力(多候選取較近者)、下方取最近支撐", () => {
    // i=9、price=16:上方 swing high 有 20(c3)與 30(c6),最近取 20;下方 swing low 有 1(c3)與 2(c6),最近取 2。
    const { res, sup } = nearestSR(high, low, 9, 2, 16);
    expect(res).toBe(20);
    expect(sup).toBe(2);
  });

  test("尚未被右側 span 根確認的轉折不納入(避免前視)", () => {
    // i=7、price=25:c6(=30)要到 i≥8 才被右側 2 根確認。有防前視守衛 → 排除 c6;
    // 上方唯一較早的 swing high 是 c3=20(< 25 不算壓力)→ 回 NaN。
    // 若拿掉 center ≤ i-span 守衛,c6=30 會被誤納入而回 30 —— 本測試即用來抓這種回歸。
    const { res } = nearestSR(high, low, 7, 2, 25);
    expect(Number.isNaN(res)).toBe(true);
  });

  test("上方無壓力時回 NaN", () => {
    const { res } = nearestSR(high, low, 9, 2, 999);
    expect(Number.isNaN(res)).toBe(true);
  });
});

describe("slopeSign", () => {
  test("上升回 1、下降回 -1、持平回 0", () => {
    expect(slopeSign([1, 2, 3, 4, 5], 4, 2)).toBe(1);
    expect(slopeSign([5, 4, 3, 2, 1], 4, 2)).toBe(-1);
    expect(slopeSign([3, 3, 3, 3, 3], 4, 2)).toBe(0);
  });

  test("回看超出範圍或含 NaN 回 0", () => {
    expect(slopeSign([1, 2, 3], 1, 5)).toBe(0);
    expect(slopeSign([Number.NaN, 2, 3], 2, 2)).toBe(0);
  });
});

describe("shadowScore", () => {
  test("長上影線(收盤偏低)回負", () => {
    // open=10 close=10.2 high=12 low=9.9:上影 1.8、下影 0.1 → 明顯負。
    expect(shadowScore(10, 12, 9.9, 10.2)).toBeLessThan(-0.5);
  });

  test("長下影線(收盤偏高)回正", () => {
    expect(shadowScore(10, 10.3, 8, 10.1)).toBeGreaterThan(0.5);
  });

  test("range 為 0 回 0、且結果 clamp 於 ±1", () => {
    expect(shadowScore(10, 10, 10, 10)).toBe(0);
    const v = shadowScore(10, 20, 9.99, 10.01);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });
});
