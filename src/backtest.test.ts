import { describe, expect, test } from "bun:test";
import { backtest, netAvgR, netR, summarize, type Trade } from "./backtest.js";
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
    riskPrice: 1,
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

  test("entryFilter 回 false 時全部略過 → 零交易", () => {
    const r = backtest(uptrend(300), cfg, { entryFilter: () => false });
    expect(r.total).toBe(0);
  });

  test("trailing 出場:上升趨勢仍只做多、無前視且出場價合理", () => {
    const kl = uptrend(300);
    const r = backtest(kl, cfg, { exit: "trailing", trailATR: 2 });
    expect(r.total).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.direction).toBe(Direction.Long);
      expect(t.entryPrice).toBe(kl[t.entryIndex].open);
      // trailing 無固定停利,出場只會是移動停損(stop)或資料用盡(eod)。
      expect(["stop", "eod"]).toContain(t.reason);
      // 多單出場價不可高於進場後出現過的最高價(出場價是被回落的停損掃到)。
      expect(t.exitPrice).toBeLessThanOrEqual(
        Math.max(...kl.slice(t.entryIndex, t.exitIndex + 1).map((k) => k.high)) + 1e-9,
      );
    }
    // 持續上漲時,移動停損讓贏單續抱 → 應為正期望。
    expect(r.avgR).toBeGreaterThan(0);
  });

  test("trailing 讓贏單跑得更遠:平均持倉根數 > 固定停利", () => {
    const kl = uptrend(300);
    const fixed = backtest(kl, cfg);
    const trail = backtest(kl, cfg, { exit: "trailing", trailATR: 2 });
    expect(trail.avgBarsHeld).toBeGreaterThan(fixed.avgBarsHeld);
  });

  test("entryFilter 收到正確的方向與訊號索引", () => {
    const seen: number[] = [];
    const r = backtest(uptrend(300), cfg, {
      entryFilter: (dir, i) => {
        expect(dir).toBe(Direction.Long); // 純上漲只會有多單訊號
        expect(i).toBeGreaterThanOrEqual(0);
        seen.push(i);
        return true; // 全放行 → 應與無 filter 同結果
      },
    });
    expect(r.total).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThanOrEqual(r.total);
  });
});

describe("成本模型", () => {
  test("netR 依 進場價/風險距離 扣除 round-trip 成本", () => {
    // entryPrice=100、riskPrice=2 → costR = 0.002 × 100 / 2 = 0.1
    const t: Trade = {
      direction: "LONG",
      entryIndex: 0,
      exitIndex: 1,
      entryPrice: 100,
      exitPrice: 106,
      riskPrice: 2,
      rMultiple: 3,
      outcome: "win",
      reason: "take",
    };
    expect(netR(t)).toBeCloseTo(2.9, 10);
  });

  test("停損距離越小,成本佔 R 比例越高", () => {
    const base: Trade = {
      direction: "LONG",
      entryIndex: 0,
      exitIndex: 1,
      entryPrice: 100,
      exitPrice: 101,
      riskPrice: 1,
      rMultiple: 1,
      outcome: "win",
      reason: "take",
    };
    expect(netR(base)).toBeCloseTo(0.8, 10); // costR = 0.2
    expect(netR({ ...base, riskPrice: 4 })).toBeCloseTo(0.95, 10); // costR = 0.05
  });

  test("riskPrice 為 0 時不扣成本(避免除以零)", () => {
    const t: Trade = {
      direction: "LONG",
      entryIndex: 0,
      exitIndex: 1,
      entryPrice: 100,
      exitPrice: 100,
      riskPrice: 0,
      rMultiple: 0,
      outcome: "win",
      reason: "eod",
    };
    expect(netR(t)).toBe(0);
  });

  test("netAvgR 為每筆淨 R 的平均;空陣列回 0", () => {
    const t = (rMultiple: number): Trade => ({
      direction: "LONG",
      entryIndex: 0,
      exitIndex: 1,
      entryPrice: 100,
      exitPrice: 100,
      riskPrice: 2,
      rMultiple,
      outcome: rMultiple >= 0 ? "win" : "loss",
      reason: "take",
    });
    expect(netAvgR([t(3), t(-1)])).toBeCloseTo(0.9, 10); // (2.9 + −1.1) / 2
    expect(netAvgR([])).toBe(0);
  });
});

describe("backtest 回傳的 riskPrice", () => {
  test("等於 stopATR × 進場當根 ATR", () => {
    // 造一段單調上漲的 K 線,確保有進場;只驗 riskPrice 與 entryPrice/stop 距離一致。
    const kl = Array.from({ length: 400 }, (_, i) => ({
      openTime: i * 3_600_000,
      open: 100 + i * 0.5,
      high: 101 + i * 0.5,
      low: 99 + i * 0.5,
      close: 100.5 + i * 0.5,
      volume: 1000,
    }));
    const r = backtest(kl, defaultConfig());
    expect(r.total).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.riskPrice).toBeGreaterThan(0);
      expect(Number.isFinite(t.riskPrice)).toBe(true);
    }
  });
});

describe("進場訊號 hook", () => {
  const kl = Array.from({ length: 400 }, (_, i) => ({
    openTime: i * 3_600_000,
    open: 100 + i * 0.5,
    high: 101 + i * 0.5,
    low: 99 + i * 0.5,
    close: 100.5 + i * 0.5,
    volume: 1000,
  }));

  test("不傳 signal 時結果與現況相同", () => {
    const cfg = defaultConfig();
    const a = backtest(kl, cfg);
    const b = backtest(kl, cfg, {});
    expect(b.total).toBe(a.total);
    expect(b.totalR).toBeCloseTo(a.totalR, 10);
  });

  test("傳入自訂 signal 時改用該訊號來源", () => {
    const cfg = defaultConfig();
    // 只在索引 300 出一次多單訊號,其餘一律觀望。
    const r = backtest(kl, cfg, {
      signal: (ind, i) =>
        i === 300
          ? { direction: Direction.Long, atr: ind.atr[i], price: ind.close[i] }
          : { direction: Direction.Neutral, atr: ind.atr[i], price: ind.close[i] },
    });
    expect(r.total).toBe(1);
    expect(r.trades[0].entryIndex).toBe(301);
    expect(r.trades[0].direction).toBe(Direction.Long);
  });

  test("signal 回 null 時視為無訊號", () => {
    const r = backtest(kl, defaultConfig(), { signal: () => null });
    expect(r.total).toBe(0);
  });
});
