import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildScanRow, runScan } from "./scan.js";
import type { Result } from "./types.js";
import { Direction } from "./types.js";

function res(dir: (typeof Direction)[keyof typeof Direction], over: Partial<Result> = {}): Result {
  return {
    index: 10,
    direction: dir,
    score: -88,
    components: [],
    adx: 36,
    atr: 0.131,
    price: 7.155,
    regime: "趨勢",
    volRatio: 1.2,
    ...over,
  };
}

afterEach(() => mock.restore());

describe("buildScanRow", () => {
  test("有效 SHORT、HTF 與 OI 同向不衝突 → effective=SHORT", () => {
    const row = buildScanRow("LINKUSDT", res(Direction.Short), -86.9, -1, 7.16);
    expect(row.effective).toBe("SHORT");
    expect(row.htfConflict).toBe(false);
    expect(row.oiConflict).toBe(false);
    expect(row.price).toBe(7.16); // 用即時價
  });

  test("SHORT 但 OI 反向(oi=1)→ effective=DOWNGRADED、oiConflict=true", () => {
    const row = buildScanRow("DOGEUSDT", res(Direction.Short), -86.5, 1, null);
    expect(row.oiConflict).toBe(true);
    expect(row.effective).toBe("DOWNGRADED");
    expect(row.price).toBe(7.155); // live=null → 退回 res.price
  });

  test("LONG 但 HTF 反向(htf<0)→ effective=DOWNGRADED、htfConflict=true", () => {
    const row = buildScanRow("TONUSDT", res(Direction.Long, { score: 40 }), -20, 0, 1.8);
    expect(row.htfConflict).toBe(true);
    expect(row.effective).toBe("DOWNGRADED");
  });

  test("NEUTRAL 不因衝突而 DOWNGRADED,維持 NEUTRAL", () => {
    const row = buildScanRow("BTCUSDT", res(Direction.Neutral, { score: -87 }), -86, -1, 58000);
    expect(row.effective).toBe("NEUTRAL");
  });

  test("htf 或 oi 為 null → 不算衝突", () => {
    const row = buildScanRow("ETHUSDT", res(Direction.Short), null, null, 1567);
    expect(row.htfConflict).toBe(false);
    expect(row.oiConflict).toBe(false);
    expect(row.effective).toBe("SHORT");
  });
});

describe("runScan 週期參數", () => {
  test(
    "以 1h 參數呼叫 → kline 請求帶 interval=60",
    async () => {
      const urls: string[] = [];
      globalThis.fetch = mock(async (url: string) => {
        urls.push(String(url));
        throw new Error("測試中斷"); // 每幣 fail-soft,只需驗證 URL
      }) as unknown as typeof fetch;

      const rows = await runScan("1h", "4h");

      expect(rows).toEqual([]); // 全數失敗 → 空結果
      const klineUrls = urls.filter((u) => u.includes("/market/kline"));
      expect(klineUrls.length).toBeGreaterThan(0);
      for (const u of klineUrls) expect(u).toContain("interval=60");
    },
    { timeout: 30000 }
  );
});
