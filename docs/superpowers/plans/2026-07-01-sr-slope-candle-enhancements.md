# 策略增強（支撐壓力／均線斜率／K棒影線）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `signal.ts` 的 `evalAt` 內加入三個低過擬合、可回測的增強項——支撐/壓力硬降級、均線斜率降權、K 棒影線加權——全部掛在 `Config` 開關後（預設關閉），並提供 train/test 驗證腳本決定是否開啟。

**Architecture:** 三個模組只讀取既有指標陣列與 klines，實作於 `signal.ts`，因此自動可被 `backtest.ts` 逐根驗證。純計算邏輯下沉到 `ta.ts` 當可單測的純函式；`signal.ts` 負責接線與開關；`format.ts` 顯示 S/R 資訊；新增腳本 `scripts/enhance-backtest.ts` 比對開關前後的樣本外表現。

**Tech Stack:** TypeScript + ESM、零執行期依賴、`bun:test`、Web platform APIs（Workers runtime）。

## Global Constraints

- 零執行期 npm 依賴；只用 `fetch` / `crypto.subtle` / `btoa` 等 Web 平台 API。
- 所有 import 用 `.js` specifier（TS `verbatimModuleSyntax`）。
- 註解與使用者可見字串一律**繁體中文**。
- 指標陣列 NaN 對齊；`evalAt` 遇必要值 NaN 回 `null`。
- 三個新開關預設**關閉**：`defaultConfig` 不改變現有行為，除非 Task 8 依回測結果明確打開。
- 驗收門檻（`bun run check`）：`biome check .` + `tsc --noEmit` 全過；`bun test` 全綠。

---

### Task 1：型別與設定骨架

**Files:**
- Modify: `src/types.ts`（`Config`、`Weights`、`Indicators` 介面；新增 `SrInfo`、`Result.sr`）
- Modify: `src/signal.ts:15-42`（`defaultConfig`）、`src/signal.ts:55-85`（`build` 回傳 `high`/`low`）
- Test: `src/signal.test.ts`（新檔）

**Interfaces:**
- Produces:
  - `Config` 新欄位：`srFilter: boolean`、`srSpan: number`、`srBufferATR: number`、`slopeFilter: boolean`、`slopeLookback: number`、`slopeDiscount: number`、`shadowComp: boolean`
  - `Weights` 新欄位：`shadow: number`
  - `Indicators` 新欄位：`high: number[]`、`low: number[]`
  - `SrInfo { nearestRes: number; nearestSup: number; conflict: boolean }`
  - `Result` 新欄位：`sr?: SrInfo`

- [ ] **Step 1：寫失敗測試**

建立 `src/signal.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { build, defaultConfig } from "./signal.js";
import type { Kline } from "./types.js";

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

describe("defaultConfig 新增開關預設關閉", () => {
  test("三個增強開關預設 false、含新參數與影線權重", () => {
    const c = defaultConfig();
    expect(c.srFilter).toBe(false);
    expect(c.slopeFilter).toBe(false);
    expect(c.shadowComp).toBe(false);
    expect(c.srSpan).toBe(5);
    expect(c.srBufferATR).toBe(0.5);
    expect(c.slopeLookback).toBe(5);
    expect(c.slopeDiscount).toBe(0.5);
    expect(c.weights.shadow).toBe(0.5);
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
```

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/signal.test.ts`
Expected: FAIL（`srFilter` 為 `undefined`、`ind.high` 為 `undefined`）

- [ ] **Step 3：實作型別**

`src/types.ts` — `Weights` 介面加一欄：

```ts
export interface Weights {
  trend: number;
  emaCross: number;
  macd: number;
  rsi: number;
  stoch: number;
  bb: number;
  obv: number;
  shadow: number; // K 棒影線加權項
}
```

`Config` 介面在 `weights: Weights;` 之前加入：

```ts
  // 支撐/壓力硬降級:貼近反向水平價位時把訊號降為觀望。
  srFilter: boolean;
  srSpan: number; // 轉折高低點左右確認根數
  srBufferATR: number; // 「貼近」門檻(×ATR)
  // 均線斜率降權:趨勢族淨方向與長期均線斜率相反時,趨勢族權重打折(非降級)。
  slopeFilter: boolean;
  slopeLookback: number; // 量 emaLong 斜率的回看根數
  slopeDiscount: number; // 逆斜率時趨勢族權重乘數(0~1)
  shadowComp: boolean; // 啟用 K 棒影線加權項
```

`Indicators` 介面在 `close: number[];` 之後加入：

```ts
  high: number[];
  low: number[];
```

在 `Result` 介面上方新增型別，並於 `Result` 內加 `sr`：

```ts
// 最近支撐/壓力與是否牴觸(conflict = 訊號往反向水平價位撞牆)。
export interface SrInfo {
  nearestRes: number;
  nearestSup: number;
  conflict: boolean;
}
```

`Result` 介面在 `volRatio: number;` 之後加入：

```ts
  sr?: SrInfo; // 支撐/壓力感知(srFilter 關閉時為 undefined)
```

- [ ] **Step 4：實作 defaultConfig 與 build**

`src/signal.ts` `defaultConfig` 的 `weights` 那行改為（加 `shadow`）並在 `weights` 之前補新欄位：

```ts
    volumeFilter: true,
    volumeMult: 1.0,
    volumePeriod: 20,
    srFilter: false,
    srSpan: 5,
    srBufferATR: 0.5,
    slopeFilter: false,
    slopeLookback: 5,
    slopeDiscount: 0.5,
    shadowComp: false,
    weights: {
      trend: 2.0,
      emaCross: 1.5,
      macd: 1.5,
      rsi: 1.0,
      stoch: 1.0,
      bb: 1.0,
      obv: 1.0,
      shadow: 0.5,
    },
```

`src/signal.ts` `build` 回傳物件內，`close,` 之後加入：

```ts
    high,
    low,
```

- [ ] **Step 5：執行測試確認通過 + 型別檢查**

Run: `bun test src/signal.test.ts && bun run type-check`
Expected: PASS；tsc 無錯。

- [ ] **Step 6：提交**

```bash
git add src/types.ts src/signal.ts src/signal.test.ts
git commit -m "feat: 策略增強型別與設定骨架(開關預設關閉)"
```

---

### Task 2：ta.ts 純函式（nearestSR / slopeSign / shadowScore）

**Files:**
- Modify: `src/ta.ts`（檔尾新增三個純函式）
- Test: `src/ta.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: 無（純函式）
- Produces:
  - `nearestSR(high: number[], low: number[], i: number, span: number, price: number, lookback?: number): { res: number; sup: number }` — 只看 `center ≤ i - span`（已被右側確認、無前視）的轉折點；找不到回 `NaN`。
  - `slopeSign(series: number[], i: number, lookback: number): number` — 回 `1|-1|0`；資料不足或 NaN 回 `0`。
  - `shadowScore(open: number, high: number, low: number, close: number): number` — 長下影→正、長上影→負，clamp 至 ±1；range≤0 回 `0`。

- [ ] **Step 1：寫失敗測試**

`src/ta.test.ts` 最上方 import 補上三個函式，並在檔尾新增：

```ts
describe("nearestSR", () => {
  // 索引 5 是明確 swing high(左右各 2 根都較低),於索引 i≥7 才被確認。
  const high = [10, 11, 12, 20, 13, 30, 14, 13, 12, 15];
  const low = [1, 2, 3, 4, 3, 5, 4, 2, 1, 3];

  test("回傳現價上方最近壓力與下方最近支撐(不前視)", () => {
    // i=9、price=16:index5 的 high=30、index3 的 high=20 都在上方,最近壓力取 20。
    const { res, sup } = nearestSR(high, low, 9, 2, 16);
    expect(res).toBe(20);
    // 下方 swing low:index0(1)、index8(1)等,取最接近 16 下方者。
    expect(sup).toBeLessThan(16);
    expect(Number.isNaN(sup)).toBe(false);
  });

  test("尚未被右側 span 根確認的轉折不納入(避免前視)", () => {
    // i=6 時,index5 的高點還沒有右側 2 根確認(需 i≥7),故不應作為壓力。
    const { res } = nearestSR(high, low, 6, 2, 16);
    expect(res).not.toBe(30);
  });

  test("上方無壓力時回 NaN", () => {
    const { res } = nearestSR(high, low, 9, 2, 999);
    expect(Number.isNaN(res)).toBe(true);
  });
});

describe("slopeSign", () => {
  test("上升回 1、下降回 -1、持平回 0", () => {
    expect(slopeSign([1, 2, 3, 4, 5], 4, 2)).toBe(1);
    expect(slopeSign([5, 4, 3, 2, 1], 4, 2)).toBe(-1);
    expect(slopeSign([3, 3, 3, 3, 3], 4, 2)).toBe(0);
  });

  test("回看超出範圍或含 NaN 回 0", () => {
    expect(slopeSign([1, 2, 3], 1, 5)).toBe(0);
    expect(slopeSign([Number.NaN, 2, 3], 2, 2)).toBe(0);
  });
});

describe("shadowScore", () => {
  test("長上影線(收盤偏低)回負", () => {
    // open=10 close=10.2 high=12 low=9.9:上影 1.8、下影 0.1 → 明顯負。
    expect(shadowScore(10, 12, 9.9, 10.2)).toBeLessThan(-0.5);
  });

  test("長下影線(收盤偏高)回正", () => {
    expect(shadowScore(10, 10.3, 8, 10.1)).toBeGreaterThan(0.5);
  });

  test("range 為 0 回 0、且結果 clamp 於 ±1", () => {
    expect(shadowScore(10, 10, 10, 10)).toBe(0);
    const v = shadowScore(10, 20, 9.99, 10.01);
    expect(v).toBeGreaterThanOrEqual(-1);
    expect(v).toBeLessThanOrEqual(1);
  });
});
```

`src/ta.test.ts` 頂部 import 改為：

```ts
import { nearestSR, shadowScore, slopeSign, swingPoints } from "./ta.js";
```

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/ta.test.ts`
Expected: FAIL（三個函式未定義）

- [ ] **Step 3：實作三個純函式**

`src/ta.ts` 檔尾新增：

```ts
// 在索引 i(含)之前、已被右側 span 根確認的轉折點中,找最接近現價的壓力(上方)與支撐(下方)。
// 只考慮 center ≤ i - span 者(右側已收滿 span 根),避免回測前視偏差。lookback 限制回看成本。
export function nearestSR(
  high: number[],
  low: number[],
  i: number,
  span: number,
  price: number,
  lookback = 200,
): { res: number; sup: number } {
  let res = Number.NaN;
  let sup = Number.NaN;
  if (span < 1) return { res, sup };
  const from = Math.max(span, i - span - lookback);
  for (let c = i - span; c >= from; c--) {
    let isHigh = true;
    let isLow = true;
    for (let j = c - span; j <= c + span; j++) {
      if (j === c) continue;
      if (high[j] >= high[c]) isHigh = false;
      if (low[j] <= low[c]) isLow = false;
    }
    if (isHigh && high[c] > price && (Number.isNaN(res) || high[c] < res)) res = high[c];
    if (isLow && low[c] < price && (Number.isNaN(sup) || low[c] > sup)) sup = low[c];
  }
  return { res, sup };
}

// 序列在索引 i 相對 lookback 根前的斜率方向:1 上、-1 下、0 持平或資料不足。
export function slopeSign(series: number[], i: number, lookback: number): number {
  const j = i - lookback;
  if (j < 0 || Number.isNaN(series[i]) || Number.isNaN(series[j])) return 0;
  const d = series[i] - series[j];
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

// 單根 K 棒影線拒絕分數:長下影→正(偏多)、長上影→負(偏空),clamp 至 ±1;range≤0 回 0。
export function shadowScore(open: number, high: number, low: number, close: number): number {
  const range = high - low;
  if (range <= 0) return 0;
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;
  const v = (lower - upper) / range;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
```

- [ ] **Step 4：執行測試確認通過**

Run: `bun test src/ta.test.ts`
Expected: PASS

- [ ] **Step 5：提交**

```bash
git add src/ta.ts src/ta.test.ts
git commit -m "feat: ta 新增 nearestSR/slopeSign/shadowScore 純函式"
```

---

### Task 3：K 棒影線加權項（含 evalAt 結構調整）

**Files:**
- Modify: `src/signal.ts:90-154`（`evalAt`：把 comps 組裝改為 trendRaw/rangeRaw 兩族陣列，條件加入影線項）、檔尾新增 `shadowComp` 函式
- Test: `src/signal.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `ta.shadowScore`（Task 2）、`Config.shadowComp` / `Weights.shadow`（Task 1）
- Produces: `evalAt` 在 `cfg.shadowComp` 為 true 時，`Result.components` 多一個 `name: "K棒影線"` 的項；為 false 時 components 與現行完全相同。

- [ ] **Step 1：寫失敗測試**

`src/signal.test.ts` 頂部 import 補 `evalAt`：

```ts
import { build, defaultConfig, evalAt } from "./signal.js";
```

新增：

```ts
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
    const ind = build(kl, defaultConfig());
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
```

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/signal.test.ts -t "影線"`
Expected: FAIL（找不到「K棒影線」項）

- [ ] **Step 3：調整 evalAt comps 組裝 + 新增 shadowComp**

`src/signal.ts` `evalAt` 內，把現行的 comps 陣列字面（`const comps: Component[] = [ ... ];`，約 line 111-119）整段替換為：

```ts
  const trendRaw: Component[] = [
    trendComp(ind, i),
    emaCrossComp(ind, i),
    macdComp(ind, i),
    obvComp(ind, i),
  ];
  const rangeRaw: Component[] = [rsiComp(ind, i), stochComp(ind, i), bbComp(ind, i)];
  if (c.shadowComp) rangeRaw.push(shadowComp(ind, i));

  const comps: Component[] = [
    ...trendRaw.map((cp) => mul(cp, trendMul)),
    ...rangeRaw.map((cp) => mul(cp, rangeMul)),
  ];
```

檔尾（其他 `*Comp` 函式旁）新增：

```ts
function shadowComp(ind: Indicators, i: number): Component {
  const k = ind.klines[i];
  const val = ta.shadowScore(k.open, k.high, k.low, k.close);
  const note = val > 0.2 ? "下影承接" : val < -0.2 ? "上影拋壓" : "影線中性";
  return { name: "K棒影線", value: val, weight: ind.cfg.weights.shadow, note };
}
```

- [ ] **Step 4：執行測試確認通過（含既有測試不回歸）**

Run: `bun test src/signal.test.ts && bun test src/backtest.test.ts`
Expected: PASS（backtest 用 defaultConfig，shadowComp 關閉 → 行為不變）

- [ ] **Step 5：提交**

```bash
git add src/signal.ts src/signal.test.ts
git commit -m "feat: signal 加入 K 棒影線加權項(預設關閉)"
```

---

### Task 4：均線斜率降權

**Files:**
- Modify: `src/signal.ts`（`evalAt`：在組裝 comps 前計算 `slopeMul`，套到趨勢族）
- Test: `src/signal.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `ta.slopeSign`（Task 2）、`Config.slopeFilter/slopeLookback/slopeDiscount`（Task 1）、Task 3 的 `trendRaw`
- Produces: `evalAt` 在 `cfg.slopeFilter` 且趨勢族淨方向與 `emaLong` 斜率相反時，趨勢族權重乘 `slopeDiscount`，使分數絕對值下降；對齊或關閉時分數不變。

- [ ] **Step 1：寫失敗測試**

`src/signal.test.ts` 新增（含一個 V 形序列：先跌 220 根、再急彈，讓趨勢族翻多但 `emaLong` 仍下彎）：

```ts
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
    const off = build(kl, defaultConfig());
    const on = build(kl, { ...defaultConfig(), slopeFilter: true });
    const i = kl.length - 1;
    expect(evalAt(on, i)?.score).toBeCloseTo(evalAt(off, i)?.score ?? 0, 6);
  });

  test("逆斜率(彈升但長均線下彎)時分數絕對值下降", () => {
    const kl = downThenBounce();
    const i = kl.length - 1;
    const off = evalAt(build(kl, defaultConfig()), i);
    const on = evalAt(build(kl, { ...defaultConfig(), slopeFilter: true }), i);
    expect(off).not.toBeNull();
    expect(on).not.toBeNull();
    expect(Math.abs(on?.score ?? 0)).toBeLessThan(Math.abs(off?.score ?? 0));
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/signal.test.ts -t "斜率"`
Expected: FAIL（逆斜率案例分數未下降——尚未實作降權）

- [ ] **Step 3：實作 slopeMul**

`src/signal.ts` `evalAt` 內，Task 3 新增的組裝段改為在 `trendRaw`/`rangeRaw` 之後、`comps` 之前插入 `slopeMul` 計算，並把趨勢族的乘數改成 `trendMul * slopeMul`：

```ts
  const trendRaw: Component[] = [
    trendComp(ind, i),
    emaCrossComp(ind, i),
    macdComp(ind, i),
    obvComp(ind, i),
  ];
  const rangeRaw: Component[] = [rsiComp(ind, i), stochComp(ind, i), bbComp(ind, i)];
  if (c.shadowComp) rangeRaw.push(shadowComp(ind, i));

  // 均線斜率降權:趨勢族淨方向與長期均線斜率相反時,把趨勢族權重打折(不降級)。
  let slopeMul = 1;
  if (c.slopeFilter) {
    const ss = ta.slopeSign(ind.emaLong, i, c.slopeLookback);
    const trendNet = sign(trendRaw.reduce((a, cp) => a + cp.value * cp.weight, 0));
    if (ss !== 0 && trendNet !== 0 && trendNet !== ss) slopeMul = c.slopeDiscount;
  }

  const comps: Component[] = [
    ...trendRaw.map((cp) => mul(cp, trendMul * slopeMul)),
    ...rangeRaw.map((cp) => mul(cp, rangeMul)),
  ];
```

- [ ] **Step 4：執行測試確認通過（含不回歸）**

Run: `bun test src/signal.test.ts && bun test src/backtest.test.ts`
Expected: PASS

- [ ] **Step 5：提交**

```bash
git add src/signal.ts src/signal.test.ts
git commit -m "feat: signal 加入均線斜率降權(預設關閉)"
```

---

### Task 5：支撐/壓力硬降級 + Result.sr

**Files:**
- Modify: `src/signal.ts`（`evalAt`：算完 `dir`、量能過濾後，套 S/R 降級並填 `sr`；回傳物件加 `sr`）
- Test: `src/signal.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `ta.nearestSR`（Task 2）、`Config.srFilter/srSpan/srBufferATR`（Task 1）、`Indicators.high/low`（Task 1）、`SrInfo`（Task 1）
- Produces: `evalAt` 在 `cfg.srFilter` 為 true 時：做多且現價貼近上方壓力（`res - price ≤ srBufferATR×ATR`）→ 降 `Neutral`；做空且貼近下方支撐 → 降 `Neutral`；並在 `Result.sr` 填入 `{ nearestRes, nearestSup, conflict }`。關閉時 `Result.sr` 為 `undefined`。

- [ ] **Step 1：寫失敗測試**

`src/signal.test.ts` 頂部 import 補型別與方向：

```ts
import { build, defaultConfig, evalAt } from "./signal.js";
import { Direction, type Kline } from "./types.js";
```

新增（「先漲到前高、回落、再彈到前高下方」使做多訊號撞壓力）：

```ts
describe("支撐/壓力硬降級(srFilter)", () => {
  // 漲到 ~130 形成前高,回落到 ~118,再彈升逼近前高(壓力)下方。
  function bumpIntoResistance(): Kline[] {
    const seq: number[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) (p *= 1.007), seq.push(p); // 上升至前高
    for (let i = 0; i < 15; i++) (p *= 0.99), seq.push(p); // 回落
    for (let i = 0; i < 20; i++) (p *= 1.006), seq.push(p); // 再彈,逼近前高下方
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
    return kl;
  }

  test("關閉時 Result.sr 為 undefined", () => {
    const kl = bumpIntoResistance();
    const ind = build(kl, defaultConfig());
    expect(evalAt(ind, kl.length - 1)?.sr).toBeUndefined();
  });

  test("開啟時做多撞上方壓力的訊號被降為觀望", () => {
    const kl = bumpIntoResistance();
    const cfg = { ...defaultConfig(), srFilter: true, srBufferATR: 1.5 };
    const off = build(kl, defaultConfig());
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
```

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/signal.test.ts -t "支撐/壓力"`
Expected: FAIL（`sr` 未定義、無降級）

- [ ] **Step 3：實作 S/R 降級**

`src/signal.ts` `evalAt` 內，於量能過濾區塊之後、`return { ... }` 之前插入：

```ts
  // 支撐/壓力硬降級:貼近反向水平價位時降為觀望(與 MTF/OI「非對抗過濾」一致)。
  let sr: SrInfo | undefined;
  if (c.srFilter) {
    const price = ind.close[i];
    const { res: nearestRes, sup: nearestSup } = ta.nearestSR(ind.high, ind.low, i, c.srSpan, price);
    const buf = c.srBufferATR * ind.atr[i];
    let conflict = false;
    if (dir === Direction.Long && !Number.isNaN(nearestRes) && nearestRes - price <= buf) {
      conflict = true;
    }
    if (dir === Direction.Short && !Number.isNaN(nearestSup) && price - nearestSup <= buf) {
      conflict = true;
    }
    if (conflict) dir = Direction.Neutral;
    sr = { nearestRes, nearestSup, conflict };
  }
```

並把回傳物件的 `volRatio,` 之後加入 `sr,`：

```ts
    volRatio,
    sr,
```

`src/signal.ts` 頂部 `import` 從 `./types.js` 補上 `SrInfo`：

```ts
import {
  type Component,
  type Config,
  Direction,
  type DirectionValue,
  type Indicators,
  type Kline,
  type Regime,
  type Result,
  type SrInfo,
} from "./types.js";
```

- [ ] **Step 4：執行測試確認通過（含不回歸）**

Run: `bun test src/signal.test.ts && bun test src/backtest.test.ts && bun run type-check`
Expected: PASS

- [ ] **Step 5：提交**

```bash
git add src/signal.ts src/signal.test.ts
git commit -m "feat: signal 加入支撐/壓力硬降級與 Result.sr(預設關閉)"
```

---

### Task 6：卡片顯示支撐/壓力

**Files:**
- Modify: `src/format.ts:150-161`（`neutralNote` 處理 sr 牴觸）、`src/format.ts:241-246`（OI 列之後加一列 S/R）
- Test: `src/format.test.ts`（新增 test）

**Interfaces:**
- Consumes: `Result.sr`（Task 5）
- Produces: `buildBubble` 在 `res.sr` 存在時多顯示一列「支撐/壓力」；`res.sr.conflict` 時 `neutralNote` 回傳撞牆說明。

- [ ] **Step 1：寫失敗測試**

先看既有 `src/format.test.ts` 的 import 與建構 `Result`/`Indicators` 的方式，沿用同款 helper。新增（若既有測試已有建立 `Result` 的 helper，重用之，僅補 `sr` 欄位）：

```ts
import { describe, expect, test } from "bun:test";
import { buildBubble } from "./format.js";
import { build, defaultConfig, evalAt } from "./signal.js";
import { uptrend } from "./signal.test.js";
import type { AnalyzeCommand } from "./types.js";

describe("卡片顯示支撐/壓力", () => {
  const meta: AnalyzeCommand = {
    help: false,
    symbol: "BTCUSDT",
    interval: "4h",
    market: "futures",
    leverage: 1,
  };

  test("res.sr 存在時 bubble JSON 含支撐/壓力文字", () => {
    const kl = uptrend(80);
    const ind = build(kl, { ...defaultConfig(), srFilter: true });
    const res = evalAt(ind, kl.length - 1);
    if (!res) throw new Error("res 應存在");
    const bubble = buildBubble(meta, ind, res);
    expect(JSON.stringify(bubble)).toContain("支撐/壓力");
  });
});
```

若 `src/signal.test.ts` 尚未 `export` `uptrend`，在該檔的 `uptrend` 前加 `export`（Task 1 已用 `export function uptrend`，此處確認即可）。

- [ ] **Step 2：執行測試確認失敗**

Run: `bun test src/format.test.ts -t "支撐/壓力"`
Expected: FAIL（bubble 不含該文字）

- [ ] **Step 3：實作卡片列與 neutralNote**

`src/format.ts` `neutralNote` 函式開頭（`if (htf?.conflict)` 之前）加入：

```ts
  if (res.sr?.conflict) {
    return res.score > 0
      ? "📌 上方緊鄰壓力,追多勝算低,降級為觀望,等突破或回踩再說。"
      : "📌 下方緊鄰支撐,追空勝算低,降級為觀望,等跌破或反彈再說。";
  }
```

`src/format.ts` `buildBubble` 內，OI 列區塊（`if (oi) { ... }`）之後加入：

```ts
  // 支撐/壓力感知(srFilter 開啟才有)。
  if (res.sr) {
    const parts: string[] = [];
    if (!Number.isNaN(res.sr.nearestSup)) parts.push(`支 ${fmtNum(res.sr.nearestSup)}`);
    if (!Number.isNaN(res.sr.nearestRes)) parts.push(`壓 ${fmtNum(res.sr.nearestRes)}`);
    const value = res.sr.conflict ? "緊鄰反向 ✗" : parts.length ? parts.join("｜") : "無明確水平";
    const color = res.sr.conflict ? COLOR.short : COLOR.sub;
    body.push(kvRow("支撐/壓力", value, color, res.sr.conflict ? "bold" : "regular"));
  }
```

- [ ] **Step 4：執行測試確認通過（含不回歸）**

Run: `bun test src/format.test.ts && bun run type-check`
Expected: PASS

- [ ] **Step 5：提交**

```bash
git add src/format.ts src/format.test.ts src/signal.test.ts
git commit -m "feat: 卡片顯示支撐/壓力與撞牆觀望說明"
```

---

### Task 7：驗證腳本 enhance-backtest.ts

**Files:**
- Create: `scripts/enhance-backtest.ts`
- Modify: `package.json:6-18`（`scripts` 加一行）
- Test: 無單元測試（網路整合腳本；以人工執行輸出驗收）

**Interfaces:**
- Consumes: `backtest`、`summarize`、`fetchKlines`、`build`、`evalAt`、`minBars`、`defaultConfig`（既有）
- Produces: `bun run enhance-backtest [interval]` 印出 baseline 與各開關組合在 **test 集** 的 `avgR`、`minPF`、`賺錢標的比例`，供 Task 8 決策。

- [ ] **Step 1：建立腳本**

沿用 `scripts/optimize.ts` 的深抓/快取/train-test 分割/跨標的彙總骨架，只改「變體 = 開關組合」。建立 `scripts/enhance-backtest.ts`：

```ts
#!/usr/bin/env bun
// 驗證三個策略增強(支撐壓力/斜率/影線)是否在樣本外泛化。
// 方法:前 70% 訓練、後 30% 測試;baseline vs 逐一開關,比較 test 集 avgR、minPF、賺錢標的比例。
// 採用準則:test 集 avgR 不劣於 baseline 且「賺錢標的數」不減少(單一標的變好不算數)。
// 用法:bun run enhance-backtest [interval]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type Trade } from "../src/backtest.js";
import { fetchKlines } from "../src/bybit.js";
import { defaultConfig } from "../src/signal.js";
import type { Config, Kline } from "../src/types.js";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
];
const CACHE_DIR =
  "/private/tmp/claude-501/-Users-riversoft-Desktop-workSpace-side-project-crypto-signal-bot/f000ee31-9958-4dd7-acc2-3271c86fdc50/scratchpad/klines";

async function loadKlines(symbol: string, interval: string, maxBars: number): Promise<Kline[]> {
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

function split(kl: Kline[]): { train: Kline[]; test: Kline[] } {
  const cut = Math.floor(kl.length * 0.7);
  return { train: kl.slice(0, cut), test: kl.slice(cut) };
}

interface Agg {
  total: number;
  avgR: number;
  minPF: number;
  profitable: number;
  count: number;
}

function evalConfig(data: Kline[][], cfg: Config): Agg {
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const kl of data) {
    const r = backtest(kl, cfg);
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
    minPF: minPF === Number.POSITIVE_INFINITY ? 0 : minPF,
    profitable,
    count: data.length,
  };
}

function fmt(a: Agg): string {
  const pf = a.minPF === Infinity ? "∞" : a.minPF.toFixed(2);
  return `n=${String(a.total).padStart(4)} avgR=${a.avgR.toFixed(3).padStart(6)} minPF=${pf.padStart(4)} 賺錢=${a.profitable}/${a.count}`;
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const maxBars = interval.endsWith("m") ? 8000 : interval === "1h" ? 12000 : 3000;
  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根)…`);
  const test: Kline[][] = [];
  for (const symbol of SYMBOLS) {
    try {
      const kl = await loadKlines(symbol, interval, maxBars);
      if (kl.length <= 500) continue;
      test.push(split(kl).test);
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  const base = defaultConfig();
  const variants: { label: string; patch: Partial<Config> }[] = [
    { label: "baseline", patch: {} },
    { label: "只影線 shadowComp", patch: { shadowComp: true } },
    { label: "只斜率 slopeFilter", patch: { slopeFilter: true } },
    { label: "只支撐壓力 srFilter", patch: { srFilter: true } },
    { label: "三者全開", patch: { shadowComp: true, slopeFilter: true, srFilter: true } },
  ];
  console.log("\n【test 集(樣本外)表現】");
  for (const v of variants) {
    console.log(`  ${v.label.padEnd(18)} ${fmt(evalConfig(test, { ...base, ...v.patch }))}`);
  }
  console.log(
    "\n判讀:某開關的 avgR 不劣於 baseline 且『賺錢標的數』不減少才採用(Task 8 據此打開預設)。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2：加入 npm script**

`package.json` `scripts` 內，`"optimize": ...` 之後加一行：

```json
    "optimize": "bun scripts/optimize.ts",
    "enhance-backtest": "bun scripts/enhance-backtest.ts"
```

（注意在前一行補逗號。）

- [ ] **Step 3：型別檢查與試跑**

Run: `bun run type-check`
Expected: tsc 無錯。

Run: `bun run enhance-backtest 4h`
Expected: 印出五個變體在 test 集的 `n / avgR / minPF / 賺錢標的比例`。（需網路；首次抓資料，之後讀快取。）

- [ ] **Step 4：提交**

```bash
git add scripts/enhance-backtest.ts package.json
git commit -m "feat: 增強驗證腳本 enhance-backtest(train/test 樣本外比對)"
```

---

### Task 8：依驗證結果決定預設開關

**Files:**
- Modify: `src/signal.ts`（`defaultConfig`：把通過準則的模組開關改 `true`，並加回測結論註解）
- Test: 既有測試（若打開某開關會改變 backtest 整合測試的具體數字，需同步調整 `src/backtest.test.ts` 的斷言為新值——只在數字型斷言，不放寬語意）

**Interfaces:**
- Consumes: Task 7 腳本輸出
- Produces: `defaultConfig` 中通過驗證的開關為 `true`，並比照 `takeATR`/`volumeMult` 風格附回測數據註解；未通過者維持 `false`。

- [ ] **Step 1：跑驗證取得數據**

Run: `bun run enhance-backtest 4h`
記下每個開關相對 baseline 的 `avgR` 與 `賺錢標的數`。

- [ ] **Step 2：套用採用準則**

準則（與 memory 教訓一致，避免過擬合）：某開關**同時**滿足才打開——
1. test 集 `avgR` ≥ baseline 的 `avgR`（不劣化樣本外期望）。
2. `賺錢標的數` ≥ baseline（不是靠單一標的僥倖）。
3. `minPF` 不低於 baseline 太多（不製造某標的的災難尾部）。

對**每個**通過的開關，在 `src/signal.ts` `defaultConfig` 把對應欄位改 `true`，並在該行後加註解，例：

```ts
    srFilter: true, // 回測(4h、8 標的、train/test):test avgR 由 0.0XX→0.0YY、賺錢標的 N→M,樣本外泛化。
```

未通過者保持 `false`，並加一行註解說明「回測未泛化，暫不預設開啟」。

- [ ] **Step 3：同步既有測試斷言**

若有打開任何開關：

Run: `bun test`
若 `src/backtest.test.ts` 有數字型斷言因預設變動而失敗，逐一核對新輸出是否合理（方向/無前視性質不變、只是筆數或 R 改變），把**數字**更新為新值。不得為了通過而放寬語意斷言（如「上升趨勢只做多」必須仍成立）。

- [ ] **Step 4：全量驗收**

Run: `bun run check && bun test`
Expected: `biome check .` + `tsc --noEmit` 全過；`bun test` 全綠。

- [ ] **Step 5：提交**

```bash
git add src/signal.ts src/backtest.test.ts
git commit -m "feat: 依樣本外回測結果啟用通過驗證的策略增強"
```

---

## Self-Review

**Spec 覆蓋：**
- 模組 1（S/R 硬降級）→ Task 2（nearestSR，含防前視）+ Task 5（降級 + Result.sr）+ Task 6（卡片）。✓
- 模組 2（斜率降權，不硬砍）→ Task 2（slopeSign）+ Task 4。✓
- 模組 3（K 棒影線獨立加權項，不做多根型態）→ Task 2（shadowScore）+ Task 3。✓
- 共同原則（實作於 evalAt、開關預設關閉、可回測）→ Task 1（開關預設 false）、各模組落在 `evalAt`。✓
- 驗證機制（train/test、跨標的一致、通過才開預設、比照既有註解風格）→ Task 7 + Task 8。✓
- 非目標（圖形型態、多根型態、額外 fetch）→ 計畫未納入。✓

**Placeholder 掃描：** 無 TBD/TODO；所有程式步驟均附完整程式碼。Task 8 的具體數字依賴實跑輸出（本質為決策步驟，已給明確可判定準則，非 placeholder）。

**型別一致性：** `nearestSR`/`slopeSign`/`shadowScore` 簽章在 Task 2 定義、Task 3-5 依相同簽章呼叫;`SrInfo` 欄位 `nearestRes/nearestSup/conflict` 在 Task 1 定義、Task 5 填入、Task 6 讀取,一致;`Weights.shadow`、`Config` 新欄位命名跨 Task 一致。

**防前視偏差重點：** `nearestSR` 只採 `center ≤ i - span` 的轉折(右側已確認),確保 backtest 不用到未來 K 棒——這是 S/R 模組能被 Task 7 正確驗證的前提。
