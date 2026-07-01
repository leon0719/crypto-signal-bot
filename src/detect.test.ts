import { describe, expect, test } from "bun:test";
import { computeLevels, diffNewOpportunities, filterOpportunities, keyOf } from "./detect.js";
import type { ScanRow } from "./scan.js";

function row(over: Partial<ScanRow>): ScanRow {
  return {
    symbol: "LINKUSDT",
    dir: "SHORT",
    effective: "SHORT",
    score: -88,
    regime: "趨勢",
    adx: 36,
    htf1d: -86.9,
    oi: -1,
    price: 7.16,
    atr: 0.13,
    htfConflict: false,
    oiConflict: false,
    ...over,
  };
}

describe("computeLevels", () => {
  test("做空:停損=price+2ATR、目標=price−3ATR", () => {
    expect(computeLevels("SHORT", 7.16, 0.13)).toEqual({ stop: 7.42, target: 6.77 });
  });
  test("做多:停損=price−2ATR、目標=price+3ATR", () => {
    expect(computeLevels("LONG", 100, 2)).toEqual({ stop: 96, target: 106 });
  });
  test("次美元幣用 5 位小數(做空)", () => {
    // DOGE 例:price 0.07117、atr 0.00149
    expect(computeLevels("SHORT", 0.07117, 0.00149)).toEqual({ stop: 0.07415, target: 0.0667 });
  });
});

describe("filterOpportunities", () => {
  test("只留 effective 為 LONG/SHORT,排除 NEUTRAL 與 DOWNGRADED", () => {
    const rows = [
      row({ symbol: "LINKUSDT", effective: "SHORT" }),
      row({ symbol: "BTCUSDT", effective: "NEUTRAL" }),
      row({ symbol: "DOGEUSDT", effective: "DOWNGRADED" }),
    ];
    const opps = filterOpportunities(rows);
    expect(opps.map((o) => o.symbol)).toEqual(["LINKUSDT"]);
    expect(opps[0].dir).toBe("SHORT");
    expect(opps[0].entry).toBe(7.16);
    expect(opps[0].stop).toBe(7.42);
  });
});

describe("diffNewOpportunities", () => {
  const link = filterOpportunities([row({ symbol: "LINKUSDT" })])[0];
  const bnb = filterOpportunities([row({ symbol: "BNBUSDT", price: 544.3, atr: 7.15 })])[0];

  test("prevActive 為空 → 全部是新機會", () => {
    const { news, active } = diffNewOpportunities([link, bnb], []);
    expect(news.map((o) => o.symbol)).toEqual(["LINKUSDT", "BNBUSDT"]);
    expect(active.sort()).toEqual(["BNBUSDT:SHORT", "LINKUSDT:SHORT"]);
  });

  test("已在 prevActive 的不重推,只推新出現的", () => {
    const { news, active } = diffNewOpportunities([link, bnb], ["LINKUSDT:SHORT"]);
    expect(news.map((o) => o.symbol)).toEqual(["BNBUSDT"]);
    expect(active.sort()).toEqual(["BNBUSDT:SHORT", "LINKUSDT:SHORT"]);
  });

  test("本輪消失的 key 不留在 active(下次重現會重推)", () => {
    const { active } = diffNewOpportunities([link], ["LINKUSDT:SHORT", "BNBUSDT:SHORT"]);
    expect(active).toEqual(["LINKUSDT:SHORT"]);
  });

  test("keyOf 格式為 SYMBOL:DIR", () => {
    expect(keyOf(link)).toBe("LINKUSDT:SHORT");
  });
});
