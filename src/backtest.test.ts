import { describe, expect, test } from "bun:test";
import { backtest, summarize, type Trade } from "./backtest.js";
import { defaultConfig } from "./signal.js";
import { Direction, type Kline } from "./types.js";

// 造一筆交易(只填統計需要的欄位)。
function trade(rMultiple: number, entryIndex = 0, exitIndex = 1): Trade {
  return {
    direction: Direction.Long,
    entryIndex,
    exitIndex,
    entryPrice: 100,
    exitPrice: 100 + rMultiple,
    rMultiple,
    outcome: rMultiple >= 0 ? "win" : "loss",
    reason: rMultiple >= 0 ? "take" : "stop",
  };
}

describe("summarize", () => {
  test("空交易給出零值、不除以零", () => {
    const r = summarize([]);
    expect(r.total).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.avgR).toBe(0);
    expect(r.profitFactor).toBe(0);
    expect(r.maxDrawdownR).toBe(0);
  });

  test("勝率、期望值、profit factor 計算正確", () => {
    // 2 勝(+2R 各)、2 敗(-1R 各):勝率 0.5,總 +2R,期望 +0.5R。
    const r = summarize([trade(2), trade(-1), trade(2), trade(-1)]);
    expect(r.total).toBe(4);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(2);
    expect(r.winRate).toBe(0.5);
    expect(r.totalR).toBeCloseTo(2);
    expect(r.avgR).toBeCloseTo(0.5);
    expect(r.profitFactor).toBeCloseTo(4 / 2); // 總賺 4R / 總賠 2R
    expect(r.avgWinR).toBeCloseTo(2);
    expect(r.avgLossR).toBeCloseTo(1);
  });

  test("無虧損時 profitFactor 為 Infinity", () => {
    expect(summarize([trade(2), trade(1)]).profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  test("最大回撤取權益曲線 peak-to-trough", () => {
    // 權益:+2 → +1(回 1)→ +3 → 0(回 3)。最大回撤 = 3R。
    const r = summarize([trade(2), trade(-1), trade(2), trade(-3)]);
    expect(r.maxDrawdownR).toBeCloseTo(3);
  });
});

// 生成一段平滑上升趨勢的 K 線,讓多頭訊號穩定出現。
function uptrend(n: number): Kline[] {
  const out: Kline[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1.01; // 每根 +1%
    const close = price;
    out.push({
      openTime: i * 3600_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
      volume: 1000 + i, // 量能遞增,確保最新根過量能過濾
    });
  }
  return out;
}

describe("backtest 整合", () => {
  // 量能過濾非本測試重點(平滑趨勢的量/均量比 ≈ 1),關掉以聚焦回測引擎。
  const cfg = { ...defaultConfig(), volumeFilter: false };

  test("上升趨勢只做多、且全部進場價 = 下一根開盤(無前視偏差)", () => {
    const kl = uptrend(300);
    const r = backtest(kl, cfg);

    expect(r.total).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.direction).toBe(Direction.Long); // 純上漲不該出現空單
      // 進場價必須等於進場那根的「開盤」,而非訊號根的收盤。
      expect(t.entryPrice).toBe(kl[t.entryIndex].open);
      expect(t.exitIndex).toBeGreaterThanOrEqual(t.entryIndex);
    }
    // 持續上漲 → 應為正期望。
    expect(r.avgR).toBeGreaterThan(0);
  });

  test("交易不重疊(下一筆進場晚於上一筆出場)", () => {
    const r = backtest(uptrend(300), cfg);
    for (let k = 1; k < r.trades.length; k++) {
      expect(r.trades[k].entryIndex).toBeGreaterThan(r.trades[k - 1].exitIndex);
    }
  });
});
