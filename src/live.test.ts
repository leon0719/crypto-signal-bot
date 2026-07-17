import { describe, expect, it } from "bun:test";
import type { Opportunity } from "./detect.js";
import { barOpenOf, floorToStep, planOrder, roundToStep } from "./live.js";
import type { OkxInstrument } from "./okx.js";

const INST: OkxInstrument = {
  instId: "BTC-USDT-SWAP",
  ctVal: 0.01,
  lotSz: "0.1",
  minSz: "0.1",
  tickSz: "0.1",
};

const opp = (over: Partial<Opportunity> = {}): Opportunity => ({
  symbol: "BTCUSDT",
  dir: "SHORT",
  entry: 65000,
  stop: 67000, // 2×ATR=2000 → ATR=1000,atrPct≈1.54 → 槓桿 3x(risk.ts)
  target: 62000,
  score: -5,
  regime: "趨勢",
  adx: 30,
  htf1d: -3,
  oi: -1,
  ...over,
});

describe("步長取整", () => {
  it("floorToStep 依步長向下取整並保留位數", () => {
    expect(floorToStep(1.2345, "0.1")).toBe("1.2");
    expect(floorToStep(7, "1")).toBe("7");
    expect(floorToStep(0.29999999, "0.001")).toBe("0.299");
  });
  it("roundToStep 四捨五入到步長", () => {
    expect(roundToStep(64999.96, "0.1")).toBe("65000.0");
    expect(roundToStep(0.123456, "0.0001")).toBe("0.1235");
  });
});

describe("barOpenOf", () => {
  it("對齊週期開盤時間", () => {
    const fourH = 4 * 3_600_000;
    expect(barOpenOf(fourH * 10 + 123456, fourH)).toBe(fourH * 10);
  });
});

describe("planOrder", () => {
  it("風險 1%:數量 = 權益×1% ÷ 停損距離,換成合約張數", () => {
    // 權益 2000 → 風險 20 USDT;停損距離 2000 → 0.01 BTC → ctVal 0.01 → 1 張
    const plan = planOrder(opp(), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.contracts).toBe("1.0");
    expect(plan.side).toBe("sell"); // SHORT → sell
    expect(plan.leverage).toBe(3);
    expect(plan.tpPx).toBe("62000.0"); // target
    expect(plan.slPx).toBe("67000.0"); // stop
    expect(plan.notional).toBeCloseTo(1 * 0.01 * 65000);
    expect(plan.margin).toBeCloseTo(plan.notional / 3);
  });

  it("LONG → buy", () => {
    const plan = planOrder(opp({ dir: "LONG", stop: 63000, target: 68000 }), 2000, INST, 0.01);
    if ("skip" in plan) throw new Error(plan.skip);
    expect(plan.side).toBe("buy");
  });

  it("低於最小下單量 → skip", () => {
    // 權益 100 → 風險 1 USDT;距離 2000 → 0.0005 BTC = 0.05 張 < minSz 0.1
    const plan = planOrder(opp(), 100, INST, 0.01);
    expect("skip" in plan && plan.skip).toContain("最小下單量");
  });

  it("停損距離為 0 → skip(fail-closed)", () => {
    const plan = planOrder(opp({ stop: 65000 }), 2000, INST, 0.01);
    expect("skip" in plan).toBe(true);
  });
});
