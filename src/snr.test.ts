import { describe, expect, test } from "bun:test";
import { defaultSnrConfig, evalSnrAt } from "./snr.js";
import { Direction, type Indicators } from "./types.js";

// 只餵 evalSnrAt 會讀到的欄位(high/low/close/atr),其餘用 cast 略過。
function fakeInd(high: number[], low: number[], close: number[], atr: number): Indicators {
  return {
    high,
    low,
    close,
    atr: new Array(close.length).fill(atr),
  } as unknown as Indicators;
}

const cfg = { ...defaultSnrConfig(), srSpan: 2 };

describe("evalSnrAt reversal(A 反轉)", () => {
  // span=2。c=2 是 swing low(100 嚴格低於左右各 2 根)、c=6 是 swing high(124)。
  const high = [120, 118, 112, 116, 118, 122, 124, 121, 119];
  const low = [115, 112, 100, 110, 114, 118, 120, 116, 101];

  test("觸及支撐且收盤仍在其上 → 做多", () => {
    // i=8、close=101、atr=10 → band=3;price−sup=1 ≤ 3 → Long。
    const close = [118, 115, 105, 113, 116, 120, 122, 118, 101];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "reversal");
    expect(r?.direction).toBe(Direction.Long);
    expect(r?.price).toBe(101);
  });

  test("距離支撐超過 touchATR → 觀望", () => {
    // price−sup = 4 > band=3。
    const close = [118, 115, 105, 113, 116, 120, 122, 118, 104];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "reversal");
    expect(r?.direction).toBe(Direction.Neutral);
  });

  test("收盤跌破支撐 → 不做多(該水平位已不成立)", () => {
    const close = [118, 115, 105, 113, 116, 120, 122, 118, 99];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "reversal");
    expect(r?.direction).toBe(Direction.Neutral);
  });

  test("觸及壓力且收盤仍在其下 → 做空", () => {
    // i=8、close=123、res=124 → res−price=1 ≤ 3 → Short。
    const close = [118, 115, 105, 113, 116, 120, 122, 118, 123];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "reversal");
    expect(r?.direction).toBe(Direction.Short);
  });

  test("同時貼近上下兩側(過窄區間)→ 觀望", () => {
    // atr=100 → band=30,支撐 100 與壓力 124 都在範圍內,方向不明確。
    const close = [118, 115, 105, 113, 116, 120, 122, 118, 112];
    const r = evalSnrAt(fakeInd(high, low, close, 100), 8, cfg, "reversal");
    expect(r?.direction).toBe(Direction.Neutral);
  });
});

describe("evalSnrAt breakout(B 突破)", () => {
  test("收盤站上前一根的壓力超過 breakATR → 做多", () => {
    // c=2 是 swing high(130)。i=7 收 125 → 壓力 130;i=8 收 135 > 130 + 0.3×10 = 133。
    const high = [110, 112, 130, 118, 116, 114, 112, 115, 140];
    const low = [100, 102, 120, 108, 106, 104, 102, 105, 118];
    const close = [108, 110, 128, 115, 112, 110, 108, 125, 135];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "breakout");
    expect(r?.direction).toBe(Direction.Long);
  });

  test("站上壓力但幅度不足 breakATR → 觀望", () => {
    const high = [110, 112, 130, 118, 116, 114, 112, 115, 140];
    const low = [100, 102, 120, 108, 106, 104, 102, 105, 118];
    const close = [108, 110, 128, 115, 112, 110, 108, 125, 132]; // 132 < 133
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "breakout");
    expect(r?.direction).toBe(Direction.Neutral);
  });

  test("收盤跌破前一根的支撐超過 breakATR → 做空", () => {
    // c=2 是 swing low(100)。i=7 收 118 → 支撐 100;i=8 收 96 < 100 − 3 = 97。
    const high = [130, 128, 120, 126, 128, 130, 132, 129, 118];
    const low = [120, 118, 100, 112, 116, 120, 122, 118, 95];
    const close = [128, 126, 118, 124, 126, 128, 130, 118, 96];
    const r = evalSnrAt(fakeInd(high, low, close, 10), 8, cfg, "breakout");
    expect(r?.direction).toBe(Direction.Short);
  });

  test("索引 0 無前一根 → 回 null", () => {
    const high = [110, 112];
    const low = [100, 102];
    const close = [108, 110];
    expect(evalSnrAt(fakeInd(high, low, close, 10), 0, cfg, "breakout")).toBeNull();
  });
});

describe("evalSnrAt 資料不足", () => {
  test("ATR 為 NaN → 回 null", () => {
    const high = [110, 112, 130, 118, 116, 114, 112, 115, 140];
    const low = [100, 102, 120, 108, 106, 104, 102, 105, 118];
    const close = [108, 110, 128, 115, 112, 110, 108, 125, 135];
    const ind = fakeInd(high, low, close, 10);
    ind.atr[8] = Number.NaN;
    expect(evalSnrAt(ind, 8, cfg, "reversal")).toBeNull();
  });
});
