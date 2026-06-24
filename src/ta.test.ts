import { describe, expect, test } from "bun:test";
import { swingPoints } from "./ta.js";

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
