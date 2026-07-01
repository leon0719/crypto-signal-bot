import { describe, expect, test } from "bun:test";
import { build, defaultConfig, evalAt } from "./signal.js";
import { Direction, type Kline } from "./types.js";

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

describe("defaultConfig 三個增強開關依樣本外回測預設開啟", () => {
  test("三個增強開關預設 true、含新參數與影線權重", () => {
    const c = defaultConfig();
    expect(c.srFilter).toBe(true);
    expect(c.slopeFilter).toBe(true);
    expect(c.shadowComp).toBe(true);
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
    const ind = build(kl, { ...defaultConfig(), shadowComp: false });
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

describe("均線斜率降權(slopeFilter)", () => {
  // 先長跌再急彈:彈升段趨勢族偏多、但 emaLong 斜率仍向下 → 應降權。
  function downThenBounce(): Kline[] {
    const kl: Kline[] = [];
    let price = 300;
    for (let i = 0; i < 220; i++) {
      const open = price;
      price *= 0.99;
      const close = price;
      kl.push({
        openTime: i * 3600_000,
        open,
        high: Math.max(open, close) * 1.002,
        low: Math.min(open, close) * 0.998,
        close,
        volume: 1000 + i,
      });
    }
    for (let i = 0; i < 40; i++) {
      const open = price;
      price *= 1.02;
      const close = price;
      kl.push({
        openTime: (220 + i) * 3600_000,
        open,
        high: Math.max(open, close) * 1.002,
        low: Math.min(open, close) * 0.998,
        close,
        volume: 2000 + i,
      });
    }
    return kl;
  }

  test("對齊(純上升)時開關不改變分數", () => {
    const kl = uptrend(260);
    const off = build(kl, { ...defaultConfig(), slopeFilter: false });
    const on = build(kl, { ...defaultConfig(), slopeFilter: true });
    const i = kl.length - 1;
    expect(evalAt(on, i)?.score).toBeCloseTo(evalAt(off, i)?.score ?? 0, 6);
  });

  test("逆斜率(彈升但長均線下彎)時分數絕對值下降", () => {
    const kl = downThenBounce();
    const i = kl.length - 1;
    const off = evalAt(build(kl, { ...defaultConfig(), slopeFilter: false }), i);
    const on = evalAt(build(kl, { ...defaultConfig(), slopeFilter: true }), i);
    expect(off).not.toBeNull();
    expect(on).not.toBeNull();
    expect(Math.abs(on?.score ?? 0)).toBeLessThan(Math.abs(off?.score ?? 0));
  });
});

describe("支撐/壓力硬降級(srFilter)", () => {
  // 漲到 ~130 形成前高,回落到 ~118,再彈升逼近前高(壓力)下方。
  function bumpIntoResistance(): Kline[] {
    const seq: number[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) (p *= 1.007), seq.push(p); // 上升至前高
    for (let i = 0; i < 15; i++) (p *= 0.99), seq.push(p); // 回落
    for (let i = 0; i < 30; i++) (p *= 1.006), seq.push(p); // 再彈,逼近前高下方(需足夠根數才真正貼近壓力)
    const kl: Kline[] = [];
    let prev = 100;
    for (let i = 0; i < seq.length; i++) {
      const open = prev;
      const close = seq[i];
      kl.push({
        openTime: i * 3600_000,
        open,
        high: Math.max(open, close) * 1.001,
        low: Math.min(open, close) * 0.999,
        close,
        volume: 1000 + i,
      });
      prev = close;
    }
    // 峰頂那根(第 39 根,上升段最後一根)與下一根的 high 在此建構下會相等,
    // 而 swingPoints 要求嚴格大於才算轉折高點;把峰頂 high 微幅抬高以打破平手,
    // 讓它成為真正的壓力位(這正是本測試要驗證的「撞壓力」情境)。
    kl[39].high *= 1.01;
    return kl;
  }

  test("關閉時 Result.sr 為 undefined", () => {
    const kl = bumpIntoResistance();
    const ind = build(kl, { ...defaultConfig(), srFilter: false });
    expect(evalAt(ind, kl.length - 1)?.sr).toBeUndefined();
  });

  test("開啟時做多撞上方壓力的訊號被降為觀望", () => {
    const kl = bumpIntoResistance();
    const cfg = { ...defaultConfig(), srFilter: true, srBufferATR: 1.5 };
    const off = build(kl, { ...defaultConfig(), srFilter: false });
    const on = build(kl, cfg);
    let downgraded = 0;
    let checked = 0;
    for (let i = 50; i < kl.length; i++) {
      const ro = evalAt(off, i);
      const rn = evalAt(on, i);
      if (ro?.direction === Direction.Long && rn?.sr?.conflict) {
        checked++;
        expect(rn?.direction).toBe(Direction.Neutral);
        downgraded++;
      }
    }
    expect(downgraded).toBeGreaterThan(0); // 資料集確有撞壓力的做多訊號被降級
    expect(checked).toBe(downgraded);
  });
});
