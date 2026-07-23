import { describe, expect, test } from "bun:test";
import {
  computeLevels,
  diffNewOpportunities,
  filterOpportunities,
  guardOpportunities,
  keyOf,
  type Opportunity,
} from "./detect.js";
import type { ScanRow } from "./scan.js";
import { defaultConfig } from "./signal.js";

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
  // 停損/停利倍數的唯一真實來源是 signal.ts 的 defaultConfig(),回測用的也是它。
  // 2026-07-23:先前這裡寫死倍數,與 defaultConfig 不同步。收斂為單一來源後,
  // 走動前推(23 季)把 stopATR 定為 2.0——1×ATR 的兩平手續費低於 taker 成本。
  const cfg = defaultConfig();

  test("倍數取自 defaultConfig,不得寫死", () => {
    expect(cfg.stopATR).toBe(2.0);
    expect(cfg.takeATR).toBe(3.0);
  });

  test("做空:停損=price+stopATR×ATR、目標=price−takeATR×ATR", () => {
    // 7.16 + 2×0.13 = 7.42;7.16 − 3×0.13 = 6.77
    expect(computeLevels("SHORT", 7.16, 0.13)).toEqual({ stop: 7.42, target: 6.77 });
  });

  test("做多:停損=price−stopATR×ATR、目標=price+takeATR×ATR", () => {
    expect(computeLevels("LONG", 100, 2)).toEqual({ stop: 96, target: 106 });
  });

  test("次美元幣用 5 位小數(做空)", () => {
    // DOGE 例:price 0.07117、atr 0.00149 → 停損 0.07415、目標 0.0667
    expect(computeLevels("SHORT", 0.07117, 0.00149)).toEqual({ stop: 0.07415, target: 0.0667 });
  });

  test("倍數隨傳入的設定連動(回測掃參數時實盤跟著變)", () => {
    const wide = { ...cfg, stopATR: 1.0, takeATR: 4.0 };
    expect(computeLevels("LONG", 100, 2, wide)).toEqual({ stop: 98, target: 108 });
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

  test("帶出 atr,下游算槓桿不必由停損距反推", () => {
    const opps = filterOpportunities([row({ atr: 0.13 })]);
    expect(opps[0].atr).toBe(0.13);
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

function guardOpp(symbol: string, dir: "LONG" | "SHORT", score: number): Opportunity {
  return {
    symbol,
    dir,
    entry: 100,
    stop: dir === "SHORT" ? 104 : 96,
    target: dir === "SHORT" ? 94 : 106,
    atr: 2,
    score,
    regime: "趨勢",
    adx: 30,
    htf1d: null,
    oi: null,
  };
}

describe("guardOpportunities:相關性護欄", () => {
  const noOpen = { LONG: 0, SHORT: 0 };

  test("同輪同方向 ≥3 → 只留 |score| 最強一支,其餘進 dropped", () => {
    const news = [
      guardOpp("ETHUSDT", "SHORT", -70),
      guardOpp("XRPUSDT", "SHORT", -95),
      guardOpp("LINKUSDT", "SHORT", -88),
      guardOpp("NEARUSDT", "SHORT", -60),
    ];
    const { kept, dropped, notes } = guardOpportunities(news, noOpen);
    expect(kept.map((o) => o.symbol)).toEqual(["XRPUSDT"]);
    expect(dropped.map((o) => o.symbol).sort()).toEqual(["ETHUSDT", "LINKUSDT", "NEARUSDT"]);
    expect(notes.length).toBeGreaterThan(0);
  });

  test("同輪同方向 2 支 → 不觸發整批降級,全數保留", () => {
    const news = [guardOpp("ETHUSDT", "SHORT", -70), guardOpp("XRPUSDT", "SHORT", -95)];
    const { kept, dropped } = guardOpportunities(news, noOpen);
    expect(kept.length).toBe(2);
    expect(dropped.length).toBe(0);
  });

  test("方向獨立判定:3 空 1 多 → 空縮成 1 支,多不受影響", () => {
    const news = [
      guardOpp("ETHUSDT", "SHORT", -70),
      guardOpp("XRPUSDT", "SHORT", -95),
      guardOpp("LINKUSDT", "SHORT", -88),
      guardOpp("ZECUSDT", "LONG", 80),
    ];
    const { kept } = guardOpportunities(news, noOpen);
    expect(kept.map((o) => o.symbol).sort()).toEqual(["XRPUSDT", "ZECUSDT"]);
  });

  test("同方向持倉上限 3:已持 2 空 + 新 2 空 → 只留最強 1 支", () => {
    const news = [guardOpp("ETHUSDT", "SHORT", -70), guardOpp("XRPUSDT", "SHORT", -95)];
    const { kept, dropped, notes } = guardOpportunities(news, { LONG: 0, SHORT: 2 });
    expect(kept.map((o) => o.symbol)).toEqual(["XRPUSDT"]);
    expect(dropped.map((o) => o.symbol)).toEqual(["ETHUSDT"]);
    expect(notes.length).toBeGreaterThan(0);
  });

  test("已持 3 空 → 新空單全擋,多單照常", () => {
    const news = [guardOpp("ETHUSDT", "SHORT", -70), guardOpp("ZECUSDT", "LONG", 80)];
    const { kept, dropped } = guardOpportunities(news, { LONG: 0, SHORT: 3 });
    expect(kept.map((o) => o.symbol)).toEqual(["ZECUSDT"]);
    expect(dropped.map((o) => o.symbol)).toEqual(["ETHUSDT"]);
  });

  test("整批降級與持倉上限疊加:4 空且已持 2 → 仍只留最強 1 支", () => {
    const news = [
      guardOpp("ETHUSDT", "SHORT", -70),
      guardOpp("XRPUSDT", "SHORT", -95),
      guardOpp("LINKUSDT", "SHORT", -88),
      guardOpp("NEARUSDT", "SHORT", -60),
    ];
    const { kept } = guardOpportunities(news, { LONG: 0, SHORT: 2 });
    expect(kept.map((o) => o.symbol)).toEqual(["XRPUSDT"]);
  });

  test("空輸入 → 空輸出不炸", () => {
    const { kept, dropped, notes } = guardOpportunities([], noOpen);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
    expect(notes).toEqual([]);
  });
});
