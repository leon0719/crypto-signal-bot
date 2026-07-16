import { describe, expect, test } from "bun:test";
import type { Opportunity } from "./detect.js";
import {
  type Bar,
  buildScorecard,
  defaultPaperConfig,
  markToMarket,
  openPositions,
  type PaperPosition,
  settlePosition,
  sizePosition,
  summarize,
  type Summary,
} from "./paper.js";
import { runPaper } from "./paper-run.js";
import type { PaperLedger } from "./paper-state.js";

const cfg = defaultPaperConfig();
const HOUR4 = 4 * 3_600_000;
const T0 = HOUR4 * 1000; // 對齊 4h 的整點進場時刻

function opp(p: Partial<Opportunity> & Pick<Opportunity, "symbol" | "dir">): Opportunity {
  return {
    entry: 100,
    stop: 96, // 2×ATR=4 → 停損距 4%
    target: 106, // 3×ATR=6
    score: 50,
    regime: "趨勢",
    adx: 30,
    htf1d: null,
    oi: null,
    ...p,
  };
}

describe("sizePosition:固定風險 1%", () => {
  test("停損距 4% → 名目=風險/4%,命中停損虧約 1% 權益", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    expect(pos.riskAmount).toBeCloseTo(20, 6); // 2000×1%
    expect(pos.notional).toBeCloseTo(20 / 0.04, 4); // 500
    expect(pos.qty).toBeCloseTo(5, 6); // 500/100
    expect(pos.marginUsed).toBeCloseTo(500 / 3, 4); // 槓桿 3x
    expect(pos.status).toBe("OPEN");
  });

  test("多空強平價方向相反,且遠於停損(3x → 約 ±33%)", () => {
    const long = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const short = sizePosition(
      opp({ symbol: "BTCUSDT", dir: "SHORT", stop: 104, target: 94 }),
      2000,
      T0,
      cfg,
    );
    expect(long.liq).toBeCloseTo(100 * (1 - 1 / 3), 4);
    expect(short.liq).toBeCloseTo(100 * (1 + 1 / 3), 4);
    expect(long.liq).toBeLessThan(long.stop); // 停損先於強平
    expect(short.liq).toBeGreaterThan(short.stop);
  });
});

describe("sizePosition:ATR 動態槓桿", () => {
  test("低波動(ATR 0.5%)→ 5x,保證金與強平價按 5x 計", () => {
    // entry 100、stop 99 → stopDist 1 → ATR = 0.5 → 0.5% → 5x
    const pos = sizePosition(
      opp({ symbol: "BTCUSDT", dir: "LONG", entry: 100, stop: 99, target: 101.5 }),
      2000,
      T0,
      cfg,
    );
    expect(pos.leverage).toBe(5);
    expect(pos.marginUsed).toBeCloseTo(pos.notional / 5, 6);
    expect(pos.liq).toBeCloseTo(100 * (1 - 1 / 5), 6);
  });
  test("中波動(ATR 2%)→ 3x", () => {
    // entry 100、stop 96 → stopDist 4 → ATR = 2 → 2% → 3x(邊界屬低風險檔)
    const pos = sizePosition(
      opp({ symbol: "ETHUSDT", dir: "LONG", entry: 100, stop: 96, target: 106 }),
      2000,
      T0,
      cfg,
    );
    expect(pos.leverage).toBe(3);
    expect(pos.marginUsed).toBeCloseTo(pos.notional / 3, 6);
  });
  test("高波動(ATR 4%)→ 1x,SHORT 強平價在上方", () => {
    // entry 100、stop 108(SHORT)→ stopDist 8 → ATR = 4 → 4% → 1x
    const pos = sizePosition(
      opp({ symbol: "SOLUSDT", dir: "SHORT", entry: 100, stop: 108, target: 88 }),
      2000,
      T0,
      cfg,
    );
    expect(pos.leverage).toBe(1);
    expect(pos.liq).toBeCloseTo(100 * (1 + 1 / 1), 6);
  });
  test("舊帳本部位(無 leverage 欄位)結算不受影響", () => {
    const legacy = sizePosition(
      opp({ symbol: "BTCUSDT", dir: "LONG", entry: 100, stop: 96, target: 112 }),
      2000,
      T0,
      cfg,
    );
    // 模擬舊 JSON:刪掉 leverage 欄位
    const { leverage: _drop, ...rest } = legacy;
    const old = rest as PaperPosition;
    const done = settlePosition(
      old,
      [{ openTime: old.entryBarOpen + cfg.intervalMs, high: 113, low: 100, close: 112 }],
      cfg,
    );
    expect(done.status).toBe("TARGET");
    expect(done.leverage).toBeUndefined(); // 讀取端以 ?? 3 解讀,結算不改寫
  });
});

describe("settlePosition:停損/達標判定", () => {
  const barsAt = (bars: Array<Partial<Bar>>): Bar[] =>
    bars.map((b, i) => ({ openTime: T0 + (i + 1) * HOUR4, high: 100, low: 100, close: 100, ...b }));

  test("多單觸停損 → 結算 R≈-1、扣手續費後略虧超過風險", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const done = settlePosition(pos, barsAt([{ low: 95 }]), cfg);
    expect(done.status).toBe("STOP");
    expect(done.exitPrice).toBe(96);
    expect(done.rMultiple).toBeCloseTo(-1, 6);
    expect(done.pnl).toBeCloseTo(-20 - (20 / 0.04) * cfg.feeRoundTrip, 4); // -20 - 1 手續費
  });

  test("多單觸達標 → R≈+1.5", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const done = settlePosition(pos, barsAt([{ high: 107 }]), cfg);
    expect(done.status).toBe("TARGET");
    expect(done.rMultiple).toBeCloseTo(1.5, 6);
    expect(done.pnl).toBeGreaterThan(0);
  });

  test("同棒同時觸及 → 保守假設先停損", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const done = settlePosition(pos, barsAt([{ low: 95, high: 107 }]), cfg);
    expect(done.status).toBe("STOP");
  });

  test("空單觸停損(價漲破停損)", () => {
    const pos = sizePosition(
      opp({ symbol: "BTCUSDT", dir: "SHORT", stop: 104, target: 94 }),
      2000,
      T0,
      cfg,
    );
    const done = settlePosition(pos, barsAt([{ high: 105 }]), cfg);
    expect(done.status).toBe("STOP");
    expect(done.rMultiple).toBeCloseTo(-1, 6);
  });

  test("不看進場棒本身(避免看未來)", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    // 一根與進場同棒的大陰線不該觸發
    const sameBar: Bar[] = [{ openTime: pos.entryBarOpen, high: 100, low: 90, close: 95 }];
    expect(settlePosition(pos, sameBar, cfg).status).toBe("OPEN");
  });
});

describe("openPositions:去重", () => {
  test("已在場的 key 不重開", () => {
    const opps = [
      opp({ symbol: "BTCUSDT", dir: "LONG" }),
      opp({ symbol: "ETHUSDT", dir: "SHORT" }),
    ];
    const out = openPositions(opps, new Set(["BTCUSDT:LONG"]), 2000, T0, cfg);
    expect(out.map((p) => p.key)).toEqual(["ETHUSDT:SHORT"]);
  });
});

describe("summarize", () => {
  test("勝率/PF/連虧/權益", () => {
    const mk = (dir: "LONG" | "SHORT", sym: string) =>
      sizePosition(opp({ symbol: sym, dir }), 2000, T0, cfg);
    const bars = (low?: number, high?: number): Bar[] => [
      { openTime: T0 + HOUR4, high: high ?? 100, low: low ?? 100, close: 100 },
    ];
    const win = settlePosition(mk("LONG", "A"), bars(undefined, 107), cfg); // +1.5R
    const l1 = settlePosition(mk("LONG", "B"), bars(95), cfg); // 停損
    const l2 = settlePosition(mk("LONG", "C"), bars(95), cfg); // 停損
    // 給不同出場時間以驗證連虧順序
    l1.exitTime = T0 + HOUR4;
    l2.exitTime = T0 + 2 * HOUR4;
    win.exitTime = T0 + 3 * HOUR4;
    const openPos = mk("LONG", "D");

    const s = summarize([l1, l2, win, openPos], cfg);
    expect(s.closed).toBe(3);
    expect(s.open).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(1 / 3, 6);
    expect(s.maxConsecLoss).toBe(2); // l1,l2 連續在 win 之前
    expect(s.equity).toBeCloseTo(cfg.startEquity + s.realized, 6);
  });

  test("空帳不炸", () => {
    const s = summarize([], cfg);
    expect(s.closed).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.equity).toBe(cfg.startEquity);
  });
});

describe("runPaper:結算 + 開新", () => {
  test("先結算既有部位,再用新權益開新機會", async () => {
    // 既有一個多單,後續 K 線把它停損
    const existing = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const ledger: PaperLedger = { startEquity: 2000, positions: [existing] };
    const bars: Bar[] = [{ openTime: T0 + HOUR4, high: 100, low: 95, close: 96 }];
    const news = [opp({ symbol: "ETHUSDT", dir: "SHORT", entry: 100, stop: 104, target: 94 })];

    const r = await runPaper(news, ledger, cfg, async () => bars, T0 + HOUR4);
    expect(r.closed.map((p) => p.key)).toEqual(["BTCUSDT:LONG"]);
    expect(r.opened.map((p) => p.key)).toEqual(["ETHUSDT:SHORT"]);
    // 新部位用「2000 + 已結損益」定量 → riskAmount 略小於 20
    expect(r.opened[0].riskAmount).toBeLessThan(20);
    expect(r.ledger.positions).toHaveLength(2);
    expect(r.summary.closed).toBe(1);
    expect(r.summary.open).toBe(1);
  });

  test("抓 K 線失敗 → 該部位維持未結,不炸", async () => {
    const existing = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    const ledger: PaperLedger = { startEquity: 2000, positions: [existing] };
    const r = await runPaper(
      [],
      ledger,
      cfg,
      async () => {
        throw new Error("network");
      },
      T0 + HOUR4,
    );
    expect(r.summary.open).toBe(1);
    expect(r.closed).toHaveLength(0);
  });
});

describe("buildScorecard", () => {
  test("含未結浮動與 <20 筆警語", () => {
    const s = summarize([], cfg);
    const txt = buildScorecard(
      s,
      [{ symbol: "BNBUSDT", dir: "SHORT", entry: 545.8, price: 549.9, unrealized: -1.5 }],
      "測試期",
    );
    expect(txt).toContain("紙上交易成績單");
    expect(txt).toContain("BNBUSDT 空");
    expect(txt).toContain("樣本 <20 筆");
  });

  test("帶策略標籤 → 標題含「· 1h 策略」;樣本足夠時顯示自訂基準", () => {
    const s20: Summary = {
      startEquity: 2000,
      realized: 100,
      equity: 2100,
      closed: 20,
      wins: 12,
      losses: 8,
      winRate: 0.6,
      avgR: 0.1,
      profitFactor: 1.5,
      maxConsecLoss: 3,
      open: 0,
      best: 30,
      worst: -15,
    };
    const txt = buildScorecard(s20, [], "測試期", {
      strategyLabel: "1h",
      baseline: "基準:回測 1h avgR ≈ +0.05;明顯低於此值才代表策略在當前市場失效。",
    });
    expect(txt).toContain("紙上交易成績單 · 1h 策略 · 測試期");
    expect(txt).toContain("回測 1h avgR");
  });

  test("樣本 <20 筆時,即使帶 baseline 仍顯示警語", () => {
    const s = summarize([], cfg);
    const txt = buildScorecard(s, [], "測試期", { strategyLabel: "1h", baseline: "自訂基準" });
    expect(txt).toContain("樣本 <20 筆");
    expect(txt).not.toContain("自訂基準");
  });

  test("不帶 opts → 輸出與現行相同(標題無策略名)", () => {
    const s = summarize([], cfg);
    const txt = buildScorecard(s, [], "測試期");
    expect(txt).toContain("紙上交易成績單 · 測試期");
    expect(txt).not.toContain("策略");
  });
});

describe("markToMarket", () => {
  test("多單現價高於進場 → 正浮動(扣手續費)", () => {
    const pos = sizePosition(opp({ symbol: "BTCUSDT", dir: "LONG" }), 2000, T0, cfg);
    expect(markToMarket(pos, 103, cfg)).toBeGreaterThan(0);
  });
});
