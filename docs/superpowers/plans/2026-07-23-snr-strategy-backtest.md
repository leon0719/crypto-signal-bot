# SNR 支撐壓力策略回測 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可離線評估的 SNR(支撐壓力)進場策略回測,比較「A 反轉」「B 突破」與現有 4h 策略在樣本外、含成本條件下的期望值,據此決定是否採用。

**Architecture:** 新增純函式 `src/snr.ts` 產生進場方向;`src/backtest.ts` 開一個進場訊號 hook 讓回測可換訊號來源;把 `scripts/enhance-backtest.ts` 的資料載入/切段/MTF 對齊骨架抽到 `src/backtest-harness.ts` 共用;新腳本 `scripts/snr-backtest.ts` 輸出三列對照。production 訊號路徑(`signal.ts`/`analyze.ts`/`live.ts`)完全不動。

**Tech Stack:** TypeScript + ESM、Bun(`bun:test`)、零執行期相依。import 一律用 `.js` specifier(`verbatimModuleSyntax`)。

## Global Constraints

- 註解與所有使用者可見字串一律 **繁體中文**。
- 不新增 npm runtime 相依。
- 每個 task 結束前 `bun test` 與 `bun run check`(= `biome check .` + `tsc --noEmit`)必須通過。
- 不修改 `src/signal.ts` 的 `srFilter` 邏輯、不修改 `src/strategies.ts`、不碰 OKX 實盤路徑。
- 回測參數固定:4h、8 主流幣、train/test = 70/30、`exit: "trailing"`、`trailATR: 2`、成本 `feeRoundTrip = 0.002`。
- 採用門檻(不得事後挪動):MTF on 的樣本外**淨 avgR > baseline 淨 avgR**、**賺錢標的數 ≥ baseline**、**n ≥ 100**,三者須同時成立。

---

### Task 1: `Trade` 保留風險距離並計算淨 R

**Files:**
- Modify: `src/backtest.ts`(`Trade` interface、`simulateExit` 的 `close()`、新增 `netR` / `netAvgR`)
- Test: `src/backtest.test.ts`

**Interfaces:**
- Consumes: 無(第一個 task)
- Produces:
  - `Trade.riskPrice: number` — 停損距離(價格單位)
  - `export function netR(t: Trade, feeRoundTrip?: number): number`
  - `export function netAvgR(trades: Trade[], feeRoundTrip?: number): number`
  - 預設 `feeRoundTrip = 0.002`

- [ ] **Step 1: 寫失敗測試**

在 `src/backtest.test.ts` 檔案末端加入:

```ts
import { netAvgR, netR } from "./backtest.js";

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
    for (const t of r.trades) {
      expect(t.riskPrice).toBeGreaterThan(0);
      expect(Number.isFinite(t.riskPrice)).toBe(true);
    }
  });
});
```

`src/backtest.test.ts` 檔案頂端的 import 需同時涵蓋 `backtest`、`summarize`、`netR`、`netAvgR`、
`type Trade`,以及 `import { defaultConfig } from "./signal.js";`。既有的 `trade()` helper
(第 7 行附近)也要補上 `riskPrice: 1`,否則型別不過。

- [ ] **Step 2: 執行測試確認失敗**

Run: `bun test src/backtest.test.ts`
Expected: FAIL — `netR is not a function` 以及 `Trade` 缺少 `riskPrice` 的型別錯誤。

- [ ] **Step 3: 實作**

`src/backtest.ts` 的 `Trade` interface 加一個欄位(放在 `rMultiple` 之前):

```ts
  riskPrice: number; // 停損距離(價格單位),用來把手續費/滑點換算成 R
```

`simulateExit` 內部的 `close()` 回傳物件加上該欄位:

```ts
    return {
      direction: dir,
      entryIndex,
      exitIndex,
      entryPrice,
      exitPrice,
      riskPrice: risk,
      rMultiple,
      outcome: rMultiple >= 0 ? "win" : "loss",
      reason,
    };
```

檔案末端新增(接在 `summarize` 之後):

```ts
// round-trip 成本(手續費 + 滑點)換算成 R:costR = fee × 進場價 / 停損距離。
// 停損距離越小(短週期),同樣的百分比成本吃掉的 R 越多——短週期策略常敗在這裡。
export function netR(t: Trade, feeRoundTrip = 0.002): number {
  if (!(t.riskPrice > 0)) return t.rMultiple;
  return t.rMultiple - (feeRoundTrip * t.entryPrice) / t.riskPrice;
}

// 每筆淨 R 的平均。空陣列回 0。
export function netAvgR(trades: Trade[], feeRoundTrip = 0.002): number {
  if (trades.length === 0) return 0;
  let sum = 0;
  for (const t of trades) sum += netR(t, feeRoundTrip);
  return sum / trades.length;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `bun test src/backtest.test.ts && bun run check`
Expected: 全數 PASS,`check` 無輸出錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/backtest.ts src/backtest.test.ts
git commit -m "feat(backtest): Trade 保留 riskPrice 並提供淨 R 成本換算"
```

---

### Task 2: 回測的進場訊號 hook

**Files:**
- Modify: `src/backtest.ts`(`BacktestOptions`、`backtest()`、`simulateExit()` 的反手判斷)
- Test: `src/backtest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Trade.riskPrice`
- Produces:
  - `export interface SignalHit { direction: DirectionValue; atr: number; price: number }`
  - `export type SignalFn = (ind: Indicators, i: number) => SignalHit | null`
  - `BacktestOptions.signal?: SignalFn` — 省略時預設 `evalAt`,行為與現況完全相同

- [ ] **Step 1: 寫失敗測試**

在 `src/backtest.test.ts` 末端加入:

```ts
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
```

檔案頂端需 `import { Direction } from "./types.js";`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `bun test src/backtest.test.ts -t "進場訊號 hook"`
Expected: FAIL — `BacktestOptions` 沒有 `signal` 屬性的型別錯誤。

- [ ] **Step 3: 實作**

`src/backtest.ts` 頂端的 import 補上型別:

```ts
import {
  type Config,
  Direction,
  type DirectionValue,
  type Indicators,
  type Kline,
} from "./types.js";
```

在 `BacktestOptions` 之前新增型別:

```ts
// 回測的進場訊號來源。回傳 Neutral 或 null 皆視為「本根無訊號」。
// 預設為 signal.ts 的 evalAt;換成 snr.ts 的 evalSnrAt 即可回測 SNR 策略,
// 出場與風險計算完全共用,確保 A/B 比較的唯一變因是進場。
export interface SignalHit {
  direction: DirectionValue;
  atr: number;
  price: number;
}
export type SignalFn = (ind: Indicators, i: number) => SignalHit | null;
```

`BacktestOptions` 加一個欄位:

```ts
  // 進場訊號來源,省略時為 evalAt(現有評分策略)。
  signal?: SignalFn;
```

`backtest()` 內把 `const sig = evalAt(ind, i);` 改成:

```ts
  const signal: SignalFn = opts.signal ?? evalAt;

  let i = start;
  while (i < n - 1) {
    const sig = signal(ind, i);
```

(`const signal = ...` 放在 `let i = start;` 之前。)

`simulateExit` 的簽章加一個參數以取得同一個訊號來源。把:

```ts
    if (opts.reverseOnSignal && j > entryIndex && j < n - 1) {
      const s = evalAt(ind, j);
```

改為:

```ts
    if (opts.reverseOnSignal && j > entryIndex && j < n - 1) {
      const s = (opts.signal ?? evalAt)(ind, j);
```

- [ ] **Step 4: 執行測試確認通過**

Run: `bun test && bun run check`
Expected: 全數 PASS。特別確認「不傳 signal 時結果與現況相同」通過——這是既有回測不回歸的保證。

- [ ] **Step 5: Commit**

```bash
git add src/backtest.ts src/backtest.test.ts
git commit -m "feat(backtest): 進場訊號可替換,預設維持 evalAt"
```

---

### Task 3: `src/snr.ts` — A 反轉 / B 突破進場判斷

**Files:**
- Create: `src/snr.ts`
- Test: `src/snr.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SignalHit`(結構相容即可,不需 import)
- Produces:
  - `export type SnrMode = "reversal" | "breakout"`
  - `export interface SnrConfig { srSpan: number; touchATR: number; breakATR: number }`
  - `export function defaultSnrConfig(): SnrConfig` → `{ srSpan: 5, touchATR: 0.3, breakATR: 0.3 }`
  - `export function evalSnrAt(ind: Indicators, i: number, cfg: SnrConfig, mode: SnrMode): SignalHit | null`

**設計要點:** `ta.nearestSR()` 回傳的壓力嚴格在現價之上、支撐嚴格在現價之下。
因此**突破無法用當根的水平位判斷**(價格站上壓力後,該水平位就不再被回傳)。
B 模式改用「前一根收盤時的水平位」與「本根收盤價」比較,兩者都不含前視。

- [ ] **Step 1: 寫失敗測試**

建立 `src/snr.test.ts`:

```ts
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
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `bun test src/snr.test.ts`
Expected: FAIL — `Cannot find module './snr.js'`。

- [ ] **Step 3: 實作**

建立 `src/snr.ts`:

```ts
// SNR(支撐壓力)進場策略:只用水平位判斷方向,完全不看評分/EMA/RSI。
// 與 signal.ts 平行的獨立進場來源,供 backtest.ts 的 signal hook 使用。
//
// A 反轉(reversal):價格觸及水平位但尚未穿越 → 賭它被擋回來。
// B 突破(breakout):收盤明確穿越水平位 → 賭它續行。
//
// 兩者都用 ta.nearestSR()(fractal 轉折點,右側需 span 根確認,無前視偏差)。
// 注意:nearestSR 回傳的壓力嚴格在現價之上、支撐嚴格在現價之下,故「突破」無法
// 用當根的水平位判斷——價格站上壓力後該水平位就不再被回傳。B 模式因此改用
// 「前一根收盤時的水平位」對比「本根收盤價」,兩端皆為已收盤資料,同樣無前視。

import type { SignalHit } from "./backtest.js";
import * as ta from "./ta.js";
import { Direction, type DirectionValue, type Indicators } from "./types.js";

export type SnrMode = "reversal" | "breakout";

export interface SnrConfig {
  srSpan: number; // 轉折高低點左右確認根數
  touchATR: number; // A:視為「觸及」水平位的距離(×ATR)
  breakATR: number; // B:視為「有效突破」所需的穿越幅度(×ATR)
}

export function defaultSnrConfig(): SnrConfig {
  return { srSpan: 5, touchATR: 0.3, breakATR: 0.3 };
}

export function evalSnrAt(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  mode: SnrMode,
): SignalHit | null {
  const price = ind.close[i];
  const atr = ind.atr[i];
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return null;

  const direction =
    mode === "reversal" ? reversalDir(ind, i, cfg, price, atr) : breakoutDir(ind, i, cfg, price, atr);
  if (direction === null) return null;
  return { direction, atr, price };
}

// A:貼近支撐(且收盤仍在其上)做多、貼近壓力(且收盤仍在其下)做空。
// 收盤已穿越時,該水平位不會被 nearestSR 回傳,自然不成立——不需額外判斷。
// 上下兩側同時貼近(區間過窄)時方向不明確,回觀望。
function reversalDir(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  price: number,
  atr: number,
): DirectionValue {
  const { res, sup } = ta.nearestSR(ind.high, ind.low, i, cfg.srSpan, price);
  const band = cfg.touchATR * atr;
  const nearSup = Number.isFinite(sup) && price - sup <= band;
  const nearRes = Number.isFinite(res) && res - price <= band;
  if (nearSup && !nearRes) return Direction.Long;
  if (nearRes && !nearSup) return Direction.Short;
  return Direction.Neutral;
}

// B:以「前一根收盤時的水平位」為基準,本根收盤穿越超過 breakATR×ATR 才算有效突破。
function breakoutDir(
  ind: Indicators,
  i: number,
  cfg: SnrConfig,
  price: number,
  atr: number,
): DirectionValue | null {
  if (i < 1) return null;
  const prev = ind.close[i - 1];
  if (!Number.isFinite(prev)) return null;
  const { res, sup } = ta.nearestSR(ind.high, ind.low, i - 1, cfg.srSpan, prev);
  const buf = cfg.breakATR * atr;
  if (Number.isFinite(res) && price > res + buf) return Direction.Long;
  if (Number.isFinite(sup) && price < sup - buf) return Direction.Short;
  return Direction.Neutral;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `bun test src/snr.test.ts && bun run check`
Expected: 全數 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/snr.ts src/snr.test.ts
git commit -m "feat(snr): 支撐壓力進場判斷(A 反轉 / B 突破)"
```

---

### Task 4: 抽出共用回測骨架 `src/backtest-harness.ts`

**Files:**
- Create: `src/backtest-harness.ts`
- Modify: `scripts/enhance-backtest.ts`(刪除搬走的程式碼,改為 import)
- Modify: `.gitignore`(加入 `.cache`)

**Interfaces:**
- Consumes: Task 1 的 `netAvgR`、Task 2 的 `BacktestOptions.signal`
- Produces:
  - `export const HTF_MAP: Record<string, string>`
  - `export const SYMBOLS: string[]`
  - `export function barMs(interval: string): number`
  - `export function loadKlines(symbol: string, interval: string, maxBars: number): Promise<Kline[]>`
  - `export function split(kl: Kline[]): { train: Kline[]; test: Kline[] }`
  - `export function htfEntryFilter(base, htf, baseInterval, htfInterval, cfg): ((dir, i) => boolean) | undefined`
  - `export interface Dataset { symbol: string; klines: Kline[]; htf?: Kline[] }`
  - `export interface Agg { total: number; avgR: number; netAvgR: number; minPF: number; profitable: number; count: number }`
  - `export function evalConfig(data: Dataset[], cfg: Config, baseInterval: string, mtf: boolean, extra?: BacktestOptions): Agg`
  - `export function loadTestSets(interval: string): Promise<Dataset[]>` — 載入 8 標的、切出 test 段

**注意:** 搬遷時要修掉 `scripts/enhance-backtest.ts` 現有的 `CACHE_DIR` —— 它是某次 session 的
scratchpad 絕對路徑(已失效),改為專案內的 `./.cache/klines`。

- [ ] **Step 1: 建立共用模組**

建立 `src/backtest-harness.ts`(內容來自 `scripts/enhance-backtest.ts`,加上 `netAvgR` 與
`extra` 參數):

```ts
// 離線回測腳本共用骨架:歷史資料載入/快取、train/test 切段、大週期(MTF)對齊過濾、
// 多標的彙總。scripts/enhance-backtest.ts 與 scripts/snr-backtest.ts 共用,
// 確保兩者的評估條件完全一致(否則數字無法互相比較)。
// 純離線分析,不被 Worker 匯入。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type BacktestOptions, backtest, netAvgR, summarize, type Trade } from "./backtest.js";
import { fetchKlines } from "./bybit.js";
import { build, evalAt, minBars } from "./signal.js";
import { type Config, Direction, type DirectionValue, type Kline } from "./types.js";

// 各週期對應的大週期確認(與 src/analyze.ts 的 HTF_MAP、scripts/optimize.ts 一致)。
export const HTF_MAP: Record<string, string> = {
  "15m": "1h",
  "30m": "2h",
  "1h": "4h",
  "2h": "12h",
  "4h": "1d",
  "1d": "1w",
};

export const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];

const CACHE_DIR = "./.cache/klines";

export function barMs(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const u: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (u[unit] ?? 3_600_000);
}

export async function loadKlines(
  symbol: string,
  interval: string,
  maxBars: number,
): Promise<Kline[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = `${CACHE_DIR}/${symbol}-${interval}-${maxBars}.json`;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Kline[];
  } catch {
    process.stdout.write(`  抓 ${symbol} ${interval}…`);
    const k = await fetchKlines("futures", symbol, interval, maxBars);
    writeFileSync(path, JSON.stringify(k));
    console.log(` ${k.length} 根`);
    return k;
  }
}

export function split(kl: Kline[]): { train: Kline[]; test: Kline[] } {
  const cut = Math.floor(kl.length * 0.7);
  return { train: kl.slice(0, cut), test: kl.slice(cut) };
}

// 把大週期評分嚴格對齊到 base 索引(只引用「在 base 收盤前已收盤」的大週期 K 棒,無前視)。
// 回傳 entryFilter:大週期反向則略過(非衝突過濾,與卡片的「降級觀望」邏輯一致)。
export function htfEntryFilter(
  base: Kline[],
  htf: Kline[] | undefined,
  baseInterval: string,
  htfInterval: string | undefined,
  cfg: Config,
): ((dir: DirectionValue, i: number) => boolean) | undefined {
  if (!htf || !htfInterval || htf.length < minBars(cfg)) return undefined;
  const ind = build(htf, cfg);
  const baseBar = barMs(baseInterval);
  const htfBar = barMs(htfInterval);
  const score: (number | null)[] = new Array(base.length).fill(null);
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < base.length; i++) {
    const baseClose = base[i].openTime + baseBar;
    while (j < htf.length && htf[j].openTime + htfBar <= baseClose) {
      const s = evalAt(ind, j);
      if (s) last = s.score;
      j++;
    }
    score[i] = last;
  }
  return (dir, i) => {
    const s = score[i];
    if (s == null) return true; // 大週期未知 → 不擋
    return dir === Direction.Long ? s >= 0 : s <= 0; // 反向才擋
  };
}

export interface Dataset {
  symbol: string;
  klines: Kline[]; // 測試段(後 30%)
  htf?: Kline[]; // 對齊用的大週期(完整序列,未切段)
}

export interface Agg {
  total: number;
  avgR: number;
  netAvgR: number; // 扣除 round-trip 成本後的每筆期望值
  minPF: number;
  profitable: number;
  count: number;
}

// mtf=true 時,對每個標的用 htfEntryFilter 建立以時間戳對齊的大週期確認過濾器。
// extra 用來傳出場模式或替換進場訊號(signal),各變體間必須一致才能比較。
export function evalConfig(
  data: Dataset[],
  cfg: Config,
  baseInterval: string,
  mtf: boolean,
  extra: BacktestOptions = {},
): Agg {
  const htfInterval = HTF_MAP[baseInterval];
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const d of data) {
    const filter = mtf
      ? htfEntryFilter(d.klines, d.htf, baseInterval, htfInterval, cfg)
      : undefined;
    const r = backtest(d.klines, cfg, { ...extra, entryFilter: filter });
    all.push(...r.trades);
    if (r.total >= 5) {
      if (r.profitFactor < minPF) minPF = r.profitFactor;
      if (r.profitFactor > 1) profitable++;
    }
  }
  const s = summarize(all);
  return {
    total: s.total,
    avgR: s.avgR,
    netAvgR: netAvgR(all),
    minPF: minPF === Number.POSITIVE_INFINITY ? 0 : minPF,
    profitable,
    count: data.length,
  };
}

// 載入 SYMBOLS 全部標的、切出樣本外 test 段。大週期保留完整序列(對齊靠時間戳)。
export async function loadTestSets(interval: string): Promise<Dataset[]> {
  const maxBars = interval.endsWith("m") ? 8000 : interval === "1h" ? 12000 : 3000;
  const htfInterval = HTF_MAP[interval];
  const htfMaxBars = htfInterval
    ? Math.ceil((maxBars * barMs(interval)) / barMs(htfInterval)) + 300
    : 0;
  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根;大週期確認=${htfInterval ?? "無"})…`);
  const out: Dataset[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const kl = await loadKlines(symbol, interval, maxBars);
      if (kl.length <= 500) continue;
      const htf = htfInterval ? await loadKlines(symbol, htfInterval, htfMaxBars) : undefined;
      out.push({ symbol, klines: split(kl).test, htf });
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}
```

- [ ] **Step 2: 改寫 `scripts/enhance-backtest.ts` 改用共用模組**

刪除該檔中的 `HTF_MAP`、`barMs`、`htfEntryFilter`、`SYMBOLS`、`CACHE_DIR`、`loadKlines`、
`split`、`Agg`、`Dataset`、`evalConfig` 定義,以及它們用到的 `node:fs`、`backtest`、
`fetchKlines`、`build`/`evalAt`/`minBars`、`Direction` 等 import。檔案改為:

```ts
#!/usr/bin/env bun
// 驗證三個策略增強(支撐壓力/斜率/影線)是否在樣本外泛化。
// 方法:前 70% 訓練、後 30% 測試;baseline vs 逐一開關,比較 test 集 avgR、minPF、賺錢標的比例。
// 每個變體同時報「MTF off」(原始訊號)與「MTF on」(套用大週期確認過濾,貼近 production)兩列,
// 因為 src/analyze.ts 與 scripts/optimize.ts 一律套用 MTF 過濾——只看 MTF off 會失真。
// 採用準則:MTF on 的 test 集 avgR 不劣於 baseline 且「賺錢標的數」不減少(單一標的變好不算數)。
// 資料載入/切段/MTF 對齊的共用骨架在 src/backtest-harness.ts。
// 用法:bun run enhance-backtest [interval]

import { type Agg, evalConfig, loadTestSets } from "../src/backtest-harness.js";
import { defaultConfig } from "../src/signal.js";
import type { Config } from "../src/types.js";

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return `n=${String(a.total).padStart(4)} avgR=${a.avgR.toFixed(3).padStart(6)} minPF=${pf.padStart(4)} 賺錢=${a.profitable}/${a.count}`;
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const test = await loadTestSets(interval);
  const base = defaultConfig();
  const variants: { label: string; patch: Partial<Config> }[] = [
    { label: "baseline", patch: {} },
    { label: "只影線 shadowComp", patch: { shadowComp: true } },
    { label: "只斜率 slopeFilter", patch: { slopeFilter: true } },
    { label: "只支撐壓力 srFilter", patch: { srFilter: true } },
    { label: "三者全開", patch: { shadowComp: true, slopeFilter: true, srFilter: true } },
  ];
  console.log("\n【test 集(樣本外)表現 —— 每個變體對照 MTF off / MTF on】");
  for (const v of variants) {
    const cfg = { ...base, ...v.patch };
    console.log(`  ${v.label}`);
    console.log(`    MTF off  ${fmt(evalConfig(test, cfg, interval, false))}`);
    console.log(`    MTF on   ${fmt(evalConfig(test, cfg, interval, true))}`);
  }
  console.log(
    "\n判讀:以 MTF on(貼近 production 訊號)為準——某開關的 avgR 不劣於 baseline 且『賺錢標的數』不減少才採用(Task 8 據此打開預設)。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: `.gitignore` 加入快取目錄**

在 `.gitignore` 末端加一行:

```
.cache
```

- [ ] **Step 4: 驗證行為不變**

Run: `bun run check && bun run enhance-backtest 4h`
Expected: `check` 通過;腳本正常輸出五個變體 × MTF off/on 的表格(首次執行會重新抓取歷史資料並寫入 `./.cache/klines`,需數十秒)。

- [ ] **Step 5: Commit**

```bash
git add src/backtest-harness.ts scripts/enhance-backtest.ts .gitignore
git commit -m "refactor(backtest): 抽出共用回測骨架,快取路徑改為專案內 .cache"
```

---

### Task 5: `scripts/snr-backtest.ts` 三列對照腳本

**Files:**
- Create: `scripts/snr-backtest.ts`
- Modify: `package.json`(`scripts` 加 `snr-backtest`)

**Interfaces:**
- Consumes: Task 3 的 `evalSnrAt` / `defaultSnrConfig`、Task 4 的 `evalConfig` / `loadTestSets` / `Agg`
- Produces: CLI `bun run snr-backtest [interval]`

- [ ] **Step 1: 建立腳本**

建立 `scripts/snr-backtest.ts`:

```ts
#!/usr/bin/env bun
// 比較「SNR 支撐壓力進場」與現有評分策略在樣本外、含成本條件下的期望值。
//
// 三列對照(baseline / A 反轉 / B 突破),每列再分 MTF off / MTF on。
// 三者的出場完全相同(1×ATR 初始停損 + 2×ATR 移動停損),唯一變因是進場訊號來源——
// 進場與出場同時更換的話,測出的差異無法歸因。
//
// 採用門檻(見 docs/superpowers/specs/2026-07-23-snr-strategy-backtest-design.md):
// MTF on 的淨 avgR > baseline 淨 avgR、賺錢標的數 ≥ baseline、n ≥ 100,三者須同時成立。
//
// 用法:bun run snr-backtest [interval](預設 4h)

import { type Agg, evalConfig, loadTestSets } from "../src/backtest-harness.js";
import type { BacktestOptions } from "../src/backtest.js";
import { defaultConfig } from "../src/signal.js";
import { defaultSnrConfig, evalSnrAt } from "../src/snr.js";

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return (
    `n=${String(a.total).padStart(4)}` +
    ` avgR=${a.avgR.toFixed(3).padStart(6)}` +
    ` 淨avgR=${a.netAvgR.toFixed(3).padStart(6)}` +
    ` minPF=${pf.padStart(4)}` +
    ` 賺錢=${a.profitable}/${a.count}`
  );
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const test = await loadTestSets(interval);
  const cfg = defaultConfig();
  const snrCfg = defaultSnrConfig();

  // 出場條件三列共用,確保唯一變因是進場。
  const exit: BacktestOptions = { exit: "trailing", trailATR: 2 };
  const variants: { label: string; opts: BacktestOptions }[] = [
    { label: "baseline(現有評分策略)", opts: exit },
    {
      label: "SNR-A 反轉",
      opts: { ...exit, signal: (ind, i) => evalSnrAt(ind, i, snrCfg, "reversal") },
    },
    {
      label: "SNR-B 突破",
      opts: { ...exit, signal: (ind, i) => evalSnrAt(ind, i, snrCfg, "breakout") },
    },
  ];

  console.log(
    `\n【${interval} test 集(樣本外、後 30%)—— 出場統一為 1×ATR 停損 + 2×ATR 移動停損】`,
  );
  for (const v of variants) {
    console.log(`  ${v.label}`);
    console.log(`    MTF off  ${fmt(evalConfig(test, cfg, interval, false, v.opts))}`);
    console.log(`    MTF on   ${fmt(evalConfig(test, cfg, interval, true, v.opts))}`);
  }
  console.log(
    "\n判讀:以 MTF on 的『淨avgR』為準。SNR 需同時滿足 淨avgR > baseline、賺錢標的數 ≥ baseline、n ≥ 100 才採用;" +
      "未達標則記錄為否定結論,不進 STRATEGIES、不進紙上交易。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: 加入 package.json 捷徑**

`package.json` 的 `scripts` 區塊,在 `"enhance-backtest"` 之後加(注意前一行需補逗號):

```json
    "enhance-backtest": "bun scripts/enhance-backtest.ts",
    "snr-backtest": "bun scripts/snr-backtest.ts"
```

- [ ] **Step 3: 驗證腳本可執行**

Run: `bun run check && bun run snr-backtest 4h`
Expected: `check` 通過;輸出三列 × MTF off/on,每列含 `n=` / `avgR=` / `淨avgR=` / `minPF=` / `賺錢=x/8`。

若 SNR 兩列的 `n` 為 0,先檢查 `evalSnrAt` 是否因 `minBars(cfg)` 起算點過晚而幾乎沒有樣本——
不要為了湊出訊號而放寬 `touchATR`/`breakATR`,那正是過擬合的起點。

- [ ] **Step 4: Commit**

```bash
git add scripts/snr-backtest.ts package.json
git commit -m "feat(scripts): SNR 策略回測對照腳本"
```

---

### Task 6: 執行回測、依門檻判讀、寫入結論

**Files:**
- Modify: `docs/strategy-backtest.md`(新增一節記錄本次結論)

**Interfaces:**
- Consumes: Task 5 的 `bun run snr-backtest`
- Produces: 文件結論。**本 task 不修改任何策略程式碼。**

- [ ] **Step 1: 執行回測並保留完整輸出**

Run: `bun run snr-backtest 4h`
把完整輸出貼進下一步的文件裡,不要只摘錄有利的數字。

- [ ] **Step 2: 對照門檻判讀**

以 MTF on 那三列為準,逐條檢查:

1. SNR-A 或 SNR-B 的 `淨avgR` 是否 > baseline 的 `淨avgR`?
2. 該列 `賺錢=x/8` 是否 ≥ baseline 的 x?
3. 該列 `n` 是否 ≥ 100?

三條全中才算通過。**任何一條沒過就是否定結論**——不調參數重跑、不改門檻。

- [ ] **Step 3: 寫入 `docs/strategy-backtest.md`**

在該檔末端新增一節(把 `[...]` 換成實際數字與實際結論):

```markdown
## SNR(支撐壓力)獨立進場策略:[採用 / 不採用]

日期:2026-07-23。設計見 `docs/superpowers/specs/2026-07-23-snr-strategy-backtest-design.md`。
腳本:`bun run snr-backtest 4h`(`src/snr.ts`)。

問題:支撐壓力目前只當過濾器(`srFilter`)。若改當**進場訊號**,反轉型(觸及水平位反手)
與突破型(收盤穿越水平位順勢)哪個有邊際優勢?

條件:4h、8 主流幣、樣本外 test 段(後 30%)、MTF on、含 0.2% round-trip 成本、
出場統一 1×ATR 停損 + 2×ATR 移動停損(唯一變因是進場)。

| 策略 | n | 淨 avgR | minPF | 賺錢標的 |
|---|---|---|---|---|
| baseline(現有評分) | [...] | [...] | [...] | [...]/8 |
| SNR-A 反轉 | [...] | [...] | [...] | [...]/8 |
| SNR-B 突破 | [...] | [...] | [...] | [...]/8 |

結論:[...]

備註:`srFilter` 的既有結果顯示「價格接近水平位時傾向被擋下而非穿過」,那是**不進場**的
證據;本次測的是**反向進場是否賺錢**,兩者之間隔著手續費與滑點,不能互相推論。
```

- [ ] **Step 4: Commit**

```bash
git add docs/strategy-backtest.md
git commit -m "docs: SNR 獨立進場策略回測結論"
```

- [ ] **Step 5: 依結論決定後續**

- **未達標(預期較可能)**:到此為止。不改 `src/signal.ts`、不加 `STRATEGIES` 條目、
  不接紙上交易。`src/snr.ts` 與腳本保留,供日後再測第二輪變體。
- **達標**:另起一次 brainstorm 討論如何併入(並行紙上策略?加影線/回踩確認的第二輪變體?
  結構性停損?),不在本計畫範圍內。
