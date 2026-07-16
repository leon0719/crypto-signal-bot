# 每日成績單 + ATR 動態槓桿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 紙上交易成績單改為每天推播,並依 ATR 波動度計算 1x–5x 建議槓桿,套用到紙上交易記帳與 LINE 卡片。

**Architecture:** 新增純函式 `suggestLeverage(atr, price)`(`src/risk.ts`);`paper.ts` 開倉時由停損距離反推 ATR 並採用動態槓桿;`format.ts` 期貨卡片加一行建議槓桿;`scheduler.ts` 的週報條件改為每日(判斷邏輯抽成 `schedule.ts` 純函式)。

**Tech Stack:** TypeScript + ESM、bun:test、零 runtime 依賴、Cloudflare Workers 相容 API。

## Global Constraints

- 註解與所有使用者可見字串一律**繁體中文**。
- 匯入用 `.js` 副檔名 specifier(TS `verbatimModuleSyntax`)。
- 不新增任何 npm runtime 依賴。
- 每個 task 結束前:`bun test <該檔>` 通過;最後 task 跑 `bun run check` + `bun test` 全綠。
- ATR% → 槓桿分檔(門檻值屬較低風險檔):≤1%→5x、≤1.5%→4x、≤2%→3x、≤3%→2x、>3%→1x;無效輸入→1x。

---

### Task 1: `suggestLeverage` 純函式

**Files:**
- Create: `src/risk.ts`
- Test: `src/risk.test.ts`

**Interfaces:**
- Consumes: 無(純函式,零依賴)。
- Produces: `export function suggestLeverage(atr: number, price: number): number` — 回傳整數 1–5。Task 2、Task 3 都會 import 它。

- [ ] **Step 1: 寫失敗測試**

```ts
// src/risk.test.ts
import { describe, expect, test } from "bun:test";
import { suggestLeverage } from "./risk.js";

describe("suggestLeverage:ATR% 分檔", () => {
  test("低波動 ≤1% → 5x(含邊界)", () => {
    expect(suggestLeverage(0.5, 100)).toBe(5); // 0.5%
    expect(suggestLeverage(1, 100)).toBe(5); // 恰 1%
  });
  test("1–1.5% → 4x(含邊界 1.5)", () => {
    expect(suggestLeverage(1.2, 100)).toBe(4);
    expect(suggestLeverage(1.5, 100)).toBe(4);
  });
  test("1.5–2% → 3x(含邊界 2)", () => {
    expect(suggestLeverage(1.8, 100)).toBe(3);
    expect(suggestLeverage(2, 100)).toBe(3);
  });
  test("2–3% → 2x(含邊界 3)", () => {
    expect(suggestLeverage(2.5, 100)).toBe(2);
    expect(suggestLeverage(3, 100)).toBe(2);
  });
  test("高波動 >3% → 1x", () => {
    expect(suggestLeverage(3.01, 100)).toBe(1);
    expect(suggestLeverage(10, 100)).toBe(1);
  });
  test("無效輸入一律保守 1x", () => {
    expect(suggestLeverage(Number.NaN, 100)).toBe(1);
    expect(suggestLeverage(1, Number.NaN)).toBe(1);
    expect(suggestLeverage(0, 100)).toBe(1);
    expect(suggestLeverage(-1, 100)).toBe(1);
    expect(suggestLeverage(1, 0)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/risk.test.ts`
Expected: FAIL(`Cannot find module "./risk.js"`)

- [ ] **Step 3: 最小實作**

```ts
// src/risk.ts
// 依波動度(ATR 佔價格百分比)給出建議槓桿(1x–5x,階梯式)。
// 每筆固定風險 1% 下,槓桿只影響保證金占用與理論強平價——
// 波動大的幣壓低槓桿讓強平價離得夠遠,波動小的幣可提高保證金效率。
// 門檻值本身屬於較低風險檔(atrPct === 1 → 5x)。

export function suggestLeverage(atr: number, price: number): number {
  if (!Number.isFinite(atr) || !Number.isFinite(price) || atr <= 0 || price <= 0) return 1;
  const pct = (atr / price) * 100;
  if (pct <= 1) return 5;
  if (pct <= 1.5) return 4;
  if (pct <= 2) return 3;
  if (pct <= 3) return 2;
  return 1;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/risk.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/risk.ts src/risk.test.ts
git commit -m "feat: suggestLeverage 依 ATR 波動度建議 1x-5x 槓桿"
```

---

### Task 2: 紙上交易採用動態槓桿

**Files:**
- Modify: `src/paper.ts`(`PaperPosition` 介面、`sizePosition`)
- Test: `src/paper.test.ts`

**Interfaces:**
- Consumes: `suggestLeverage(atr, price)`(Task 1)。
- Produces: `PaperPosition` 新增 `leverage?: number`(新部位必填寫入;舊帳本 JSON 無此欄位,讀取端一律以 `p.leverage ?? 3` 解讀)。`sizePosition` 簽名不變。

背景:`Opportunity` 沒有 atr 欄位,但 `detect.ts` `computeLevels` 固定用 `stop = entry ∓ 2×ATR`,
所以 `ATR = |entry − stop| / 2` 可精確反推(stop 有按價格量級四捨五入,誤差可忽略)。

- [ ] **Step 1: 寫失敗測試**

在 `src/paper.test.ts` 既有 `describe("sizePosition:固定風險 1%")` 之後新增(沿用檔內既有的 `opp()` helper 與 `cfg`、`T0`;`opp()` 若不支援自訂 entry/stop 欄位,直接傳入覆寫值——現有 helper 以 `opp({...})` 部分覆寫模式運作):

```ts
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
```

(若檔頭尚未 import `settlePosition` 或 `PaperPosition` 型別,補進既有 import。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/paper.test.ts`
Expected: FAIL(`pos.leverage` 為 undefined / marginUsed 仍按 3x)

- [ ] **Step 3: 實作**

`src/paper.ts` 改動三處:

(a) 檔頭 import:

```ts
import { suggestLeverage } from "./risk.js";
```

(b) `PaperPosition` 介面(`marginUsed` 欄位前)新增:

```ts
  leverage?: number; // 開倉當下依 ATR 波動採用的槓桿(舊帳本無此欄位 → 讀取端視為 3x)
```

(c) `sizePosition` 中,原本的

```ts
  const marginUsed = notional / cfg.leverage;
  const liq =
    o.dir === "LONG" ? o.entry * (1 - 1 / cfg.leverage) : o.entry * (1 + 1 / cfg.leverage);
```

改為:

```ts
  // Opportunity 無 atr 欄位,但 detect 的停損固定是 2×ATR → 由停損距離精確反推。
  const leverage = suggestLeverage(stopDist / 2, o.entry);
  const marginUsed = notional / leverage;
  const liq = o.dir === "LONG" ? o.entry * (1 - 1 / leverage) : o.entry * (1 + 1 / leverage);
```

並在回傳物件 `marginUsed,` 之前加入 `leverage,`。
`PaperConfig.leverage` 欄位與預設值 3 保留(舊部位解讀 fallback 及註解語意),
`sizePosition` 不再讀它——把該欄位註解改為:

```ts
  leverage: number; // 舊帳本部位的 fallback 槓桿(新部位改依 ATR 動態計算,見 risk.ts)
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/paper.test.ts`
Expected: PASS(既有測試 + 新增 4 tests 全綠。若既有測試有斷言 `marginUsed`/`liq` 按 3x 計算而失敗,依其測資的 stopDist 反推 ATR% 對應的新分檔槓桿修正期望值——這是規格變更,不是 bug)

- [ ] **Step 5: Commit**

```bash
git add src/paper.ts src/paper.test.ts
git commit -m "feat: 紙上交易開倉改用 ATR 動態槓桿記帳"
```

---

### Task 3: LINE 卡片顯示建議槓桿

**Files:**
- Modify: `src/format.ts`(`buildBubble`)
- Test: `src/format.test.ts`

**Interfaces:**
- Consumes: `suggestLeverage(atr, price)`(Task 1);`res.atr`、`res.price`(`signal.ts` `Result`,buildBubble 內已在用 `res.atr`)。
- Produces: 期貨卡片(不分方向,含觀望)新增一行「⚡ 建議槓桿 Nx(ATR 波動 x.x%)」;spot 卡片不顯示。使用者自帶槓桿(`meta.leverage > 1`)時原有槓桿試算列照舊並存。

- [ ] **Step 1: 寫失敗測試**

在 `src/format.test.ts` 新增(沿用檔內既有的 buildFlexMessage 測試 fixture 慣例——檔內已有建 `meta`/`ind`/`res` 的 helper 或字面值,照抄最近一個測試的 fixture 改 market 欄位即可):

```ts
describe("建議槓桿列(ATR 動態)", () => {
  test("期貨卡片含建議槓桿列", () => {
    // 用檔內既有 fixture,確保 meta.market === "futures"
    const msg = buildFlexMessage(metaFutures, ind, res);
    const s = JSON.stringify(msg);
    expect(s).toContain("建議槓桿");
    expect(s).toMatch(/[1-5]x(GTM)?/); // 槓桿值出現
    expect(s).toContain("ATR 波動");
  });
  test("spot 卡片不顯示建議槓桿", () => {
    const msg = buildFlexMessage({ ...metaFutures, market: "spot" }, ind, res);
    expect(JSON.stringify(msg)).not.toContain("建議槓桿");
  });
  test("使用者自帶槓桿時,槓桿試算列與建議槓桿列並存", () => {
    const msg = buildFlexMessage({ ...metaFutures, leverage: 10 }, ind, res);
    const s = JSON.stringify(msg);
    expect(s).toContain("⚡ 槓桿 10×");
    expect(s).toContain("建議槓桿");
  });
});
```

(`metaFutures`/`ind`/`res` 為示意名——以檔內實際 fixture 名稱為準;`/[1-5]x/` 的 regex 若與其他文案誤撞,改成精確比對 `建議槓桿` 那行的完整字串。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/format.test.ts`
Expected: FAIL(找不到「建議槓桿」)

- [ ] **Step 3: 實作**

`src/format.ts`:

(a) 檔頭 import:

```ts
import { suggestLeverage } from "./risk.js";
```

(b) `buildBubble` 內,`if/else` 區塊結束後(觀望與有方向兩種卡片都會經過)、`return {` 之前插入:

```ts
  // 依 ATR 波動度的建議槓桿(1x–5x,詳 risk.ts)——期貨一律顯示,與使用者自帶槓桿試算並存。
  if (meta.market === "futures") {
    const suggested = suggestLeverage(res.atr, res.price);
    const atrPct = (res.atr / res.price) * 100;
    body.push(separator());
    body.push(
      kvRow("⚡ 建議槓桿", `${suggested}x(ATR 波動 ${atrPct.toFixed(1)}%)`, COLOR.text, "bold"),
    );
  }
```

注意:此段要放在既有 `if (meta.leverage > 1 && meta.market === "futures")` 槓桿試算列**之後**(即 else 分支外、return 前),避免打斷試算列的視覺群組。

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/format.test.ts`
Expected: PASS(既有 + 新增 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/format.test.ts
git commit -m "feat: LINE 卡片顯示 ATR 動態建議槓桿"
```

---

### Task 4: 成績單改每日推播

**Files:**
- Modify: `src/schedule.ts`、`scripts/scheduler.ts:40-50`
- Test: `src/schedule.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces: `export function shouldPushReport(now: Date): boolean`(`src/schedule.ts`)— 每天 UTC 00 時段回 true。`scheduler.ts` 改用它。

- [ ] **Step 1: 寫失敗測試**

在 `src/schedule.test.ts` 新增:

```ts
describe("shouldPushReport:每天 UTC0 推成績單", () => {
  test("UTC 00 時段 → true(不分星期)", () => {
    expect(shouldPushReport(new Date("2026-07-16T00:05:00Z"))).toBe(true); // 週四
    expect(shouldPushReport(new Date("2026-07-20T00:02:00Z"))).toBe(true); // 週一
  });
  test("其他掃描時段 → false", () => {
    expect(shouldPushReport(new Date("2026-07-16T04:02:00Z"))).toBe(false);
    expect(shouldPushReport(new Date("2026-07-16T20:59:00Z"))).toBe(false);
  });
});
```

(檔頭 import 補上 `shouldPushReport`。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/schedule.test.ts`
Expected: FAIL(`shouldPushReport` 未定義)

- [ ] **Step 3: 實作**

`src/schedule.ts` 追加:

```ts
// 每天 UTC 00 那輪掃描後推紙上交易成績單(2026-07-16 由每週一改為每日)。
export function shouldPushReport(now: Date): boolean {
  return now.getUTCHours() === 0;
}
```

`scripts/scheduler.ts` 改兩處:

(a) import 行改為:

```ts
import { nextRunTime, shouldPushReport } from "../src/schedule.js";
```

(b) 週報區塊(原 40–50 行)改為:

```ts
  // 每天 UTC 00 點那輪掃描後,自動推一張紙上交易成績單(日報)
  const d = new Date();
  if (everySeconds === 0 && shouldPushReport(d)) {
    console.log(`[${d.toISOString()}] 推播紙上交易日報…`);
    const rep = Bun.spawn(["bun", "scripts/paper-report.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    await rep.exited;
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts src/schedule.test.ts scripts/scheduler.ts
git commit -m "feat: 紙上交易成績單改為每日 UTC0 推播"
```

---

### Task 5: 全量驗證 + 部署

**Files:**
- 無新改動;驗證與容器重建。

**Interfaces:**
- Consumes: Task 1–4 全部。
- Produces: 通過 gate 的完整功能 + 更新後的常駐容器。

- [ ] **Step 1: 全量 gate**

Run: `bun run check && bun test`
Expected: biome + tsc 無錯誤(既有 signal.test.ts 的 3 個 noCommaOperator warning 可忽略),測試全綠。

- [ ] **Step 2: 端到端煙霧測試(本機、不進容器)**

Run: `bun -e 'const {sizePosition}=await import("./src/paper.ts");const {defaultPaperConfig}=await import("./src/paper.ts");const p=sizePosition({symbol:"BTCUSDT",dir:"LONG",entry:100,stop:96,target:112,score:50,regime:"trend",adx:30,htf1d:1,oi:0},2000,Date.now(),defaultPaperConfig());console.log(p.leverage,p.marginUsed.toFixed(2),p.liq)'`
Expected: 輸出 `3 166.67 66.66...`(2% ATR → 3x)

- [ ] **Step 3: 重建容器讓排程器吃到新程式碼**

Run: `make rebuild && docker logs docker-detector-1 2>&1 | tail -3`
Expected: 容器 Up、日誌出現「排程器啟動」。

- [ ] **Step 4: 最終 commit(若有殘留變更)與收尾**

```bash
git status --short
```

Expected: 乾淨(所有變更已在 Task 1–4 分批 commit)。
