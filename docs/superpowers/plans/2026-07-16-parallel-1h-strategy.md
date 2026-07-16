# 並行 1h 紙上交易策略(A/B 前向測試)實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在現行 4h 紙上交易外新增並行的 1h 策略,獨立記帳、每日成績單推到另一個 Slack 頻道(`SLACK_CHANNEL_ID_1H`),前向比較兩週期表現。

**Architecture:** 把「策略」抽成純資料設定(`src/strategies.ts`:週期/HTF/狀態檔/帳本/是否推訊號/頻道環境變數/基準註解),`scripts/detect.ts` 與 `scripts/paper-report.ts` 依策略名參數執行,排程器改為每小時觸發、依 `isStrategyDue` 決定該小時跑哪些策略。訊號引擎、幣種清單、風險參數兩策略完全共用——唯一變因是週期。

**Tech Stack:** TypeScript + ESM、bun:test(fetch mock)、零 runtime 相依。Spec:`docs/superpowers/specs/2026-07-16-parallel-1h-strategy-design.md`。

## Global Constraints

- 註解與使用者可見字串一律繁體中文;imports 用 `.js` 副檔名(TS `verbatimModuleSyntax`)。
- 不新增 npm runtime 相依。
- 4h 策略現行行為完全不變:同狀態檔 `./data/signal-state.json`、帳本 `./data/paper-ledger.json`、頻道 `SLACK_CHANNEL_ID`、UTC 0/4/8/12/16/20 掃描。
- 1h 策略不推進場訊號(`pushSignals: false`),只記帳 + 每日成績單。
- 環境變數 `STATE_PATH`/`PAPER_LEDGER_PATH` 覆寫**只適用 4h 策略**(既有部署相容);1h 一律用策略設定路徑。
- 每個 Task 完成後跑 `bun test` 全綠再 commit;最後跑 `bun run check`。

---

### Task 1: `src/strategies.ts` 策略設定

**Files:**
- Create: `src/strategies.ts`
- Test: `src/strategies.test.ts`

**Interfaces:**
- Produces: `interface Strategy { name, interval, htf, statePath, ledgerPath, pushSignals, channelEnv, baseline }`、`STRATEGIES: Strategy[]`(4h、1h 兩筆)、`strategyByName(name: string): Strategy`(未知名稱拋錯)、`intervalMsOf(interval: string): number`。後續 Task 6/7/8 都吃這組。

- [ ] **Step 1: 寫失敗測試 `src/strategies.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { STRATEGIES, intervalMsOf, strategyByName } from "./strategies.js";

describe("STRATEGIES", () => {
  test("name/路徑/頻道環境變數皆不重複", () => {
    const uniq = (xs: string[]) => new Set(xs).size === xs.length;
    expect(uniq(STRATEGIES.map((s) => s.name))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.statePath))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.ledgerPath))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.channelEnv))).toBe(true);
  });

  test("只有 4h 推進場訊號;1h 靜音記帳", () => {
    expect(STRATEGIES.filter((s) => s.pushSignals).map((s) => s.name)).toEqual(["4h"]);
  });

  test("1h 策略的 HTF 是 4h、頻道環境變數是 SLACK_CHANNEL_ID_1H", () => {
    const s = strategyByName("1h");
    expect(s.htf).toBe("4h");
    expect(s.channelEnv).toBe("SLACK_CHANNEL_ID_1H");
  });
});

describe("strategyByName", () => {
  test("未知名稱拋錯並列出可用策略", () => {
    expect(() => strategyByName("2h")).toThrow("未知策略");
  });
});

describe("intervalMsOf", () => {
  test("1h/4h 換算毫秒", () => {
    expect(intervalMsOf("1h")).toBe(3_600_000);
    expect(intervalMsOf("4h")).toBe(14_400_000);
  });
  test("不支援的單位拋錯", () => {
    expect(() => intervalMsOf("1x")).toThrow("不支援");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/strategies.test.ts`
Expected: FAIL(模組不存在)

- [ ] **Step 3: 實作 `src/strategies.ts`**

```ts
// 並行紙上交易策略設定:純資料。策略間唯一變因是週期,A/B 結論才乾淨。
// 幣種清單(scan.ts SYMBOLS)與風險參數(paper.ts defaultPaperConfig)兩策略共用。
export interface Strategy {
  name: string; // 顯示於成績單標題與 log
  interval: string; // 掃描週期
  htf: string; // 大週期確認
  statePath: string; // 去重狀態檔
  ledgerPath: string; // 紙上交易帳本
  pushSignals: boolean; // 是否推新機會訊號到 Slack
  channelEnv: string; // 成績單使用的 Slack channel 環境變數名
  baseline: string; // 樣本足夠時成績單顯示的基準註解
}

export const STRATEGIES: Strategy[] = [
  {
    name: "4h",
    interval: "4h",
    htf: "1d",
    statePath: "./data/signal-state.json",
    ledgerPath: "./data/paper-ledger.json",
    pushSignals: true,
    channelEnv: "SLACK_CHANNEL_ID",
    baseline: "基準:回測 4h avgR ≈ +0.10;明顯低於此值才代表策略在當前市場失效。",
  },
  {
    name: "1h",
    interval: "1h",
    htf: "4h",
    statePath: "./data/signal-state-1h.json",
    ledgerPath: "./data/paper-ledger-1h.json",
    pushSignals: false,
    channelEnv: "SLACK_CHANNEL_ID_1H",
    baseline: "基準:回測 1h avgR ≈ +0.05;明顯低於此值才代表策略在當前市場失效。",
  },
];

export function strategyByName(name: string): Strategy {
  const s = STRATEGIES.find((x) => x.name === name);
  if (!s) {
    const names = STRATEGIES.map((x) => x.name).join(", ");
    throw new Error(`未知策略:${name}(可用:${names})`);
  }
  return s;
}

// "1h"/"4h"/"1d" → 毫秒。供 PaperConfig.intervalMs 對齊進場棒。
export function intervalMsOf(interval: string): number {
  const unit = interval[interval.length - 1];
  const n = Number(interval.slice(0, -1)) || 1;
  const per: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = per[unit];
  if (!ms) throw new Error(`不支援的週期:${interval}`);
  return n * ms;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/strategies.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/strategies.ts src/strategies.test.ts
git commit -m "feat: 新增並行策略設定 strategies.ts(4h/1h)"
```

---

### Task 2: `src/slack.ts` postMessage 可選頻道

**Files:**
- Modify: `src/slack.ts:22-27`(`postMessage` 簽名)
- Test: `src/slack.test.ts`(擴充)

**Interfaces:**
- Produces: `postMessage(text: string, channelId?: string): Promise<void>` — 未傳 `channelId` 沿用 `SLACK_CHANNEL_ID`(現行為不變)。Task 7 以 `postMessage(text, ch)` 呼叫。

- [ ] **Step 1: 在 `src/slack.test.ts` 的 `describe("postMessage")` 內加失敗測試**

```ts
  test("帶 channelId → body 用指定頻道,不用 env 預設", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    const captured = { body: "" };
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      captured.body = String(init.body);
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await postMessage("哈囉", "C999");

    expect(JSON.parse(captured.body).channel).toBe("C999");
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/slack.test.ts`
Expected: FAIL(channel 仍是 "C123")

- [ ] **Step 3: 修改 `src/slack.ts` 的 `postMessage`**

```ts
// 發送到 Slack。channelId 未指定時用 SLACK_CHANNEL_ID。缺 token/頻道或 Slack 回 ok:false 皆拋錯。
export async function postMessage(text: string, channelId?: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = channelId ?? process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    throw new Error("缺少 SLACK_BOT_TOKEN 或 SLACK_CHANNEL_ID 環境變數");
  }
```

(函式其餘部分不動。)

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/slack.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack.ts src/slack.test.ts
git commit -m "feat: postMessage 支援指定 Slack 頻道"
```

---

### Task 3: `src/schedule.ts` isStrategyDue + 每小時排程測試

**Files:**
- Modify: `src/schedule.ts`(新增函式)
- Test: `src/schedule.test.ts`(擴充)

**Interfaces:**
- Consumes: 既有 `nextRunTime(now, hours, minute)`(已支援任意小時集合,不改)。
- Produces: `isStrategyDue(interval: string, now: Date): boolean` — `"Nh"` 在 UTC 小時整除 N 時為 true。Task 8 排程器用它決定每小時跑哪些策略。

- [ ] **Step 1: 在 `src/schedule.test.ts` 加失敗測試**

```ts
describe("isStrategyDue:每小時排程器決定該小時跑哪些策略", () => {
  test("1h 每小時都執行", () => {
    expect(isStrategyDue("1h", new Date("2026-07-16T05:02:00Z"))).toBe(true);
    expect(isStrategyDue("1h", new Date("2026-07-16T23:02:00Z"))).toBe(true);
  });
  test("4h 只在 UTC 小時整除 4 時執行", () => {
    expect(isStrategyDue("4h", new Date("2026-07-16T08:02:00Z"))).toBe(true);
    expect(isStrategyDue("4h", new Date("2026-07-16T09:02:00Z"))).toBe(false);
    expect(isStrategyDue("4h", new Date("2026-07-16T00:02:00Z"))).toBe(true);
  });
});

describe("nextRunTime:每小時模式(24 小時全開)", () => {
  test("任何時刻 → 下一個整點 :02", () => {
    const all = Array.from({ length: 24 }, (_, h) => h);
    const now = new Date("2026-07-01T06:05:00.000Z");
    expect(nextRunTime(now, all, 2).toISOString()).toBe("2026-07-01T07:02:00.000Z");
  });
});
```

並把檔頭 import 改為:

```ts
import { isStrategyDue, nextRunTime, shouldPushReport } from "./schedule.js";
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/schedule.test.ts`
Expected: FAIL(`isStrategyDue` 未定義)

- [ ] **Step 3: 在 `src/schedule.ts` 末尾加實作**

```ts
// 每小時觸發的排程器用:此 UTC 小時是否輪到該週期的策略。"Nh" → 小時整除 N。
// 非小時制週期(理論上不會出現)一律 true,由呼叫端自行約束。
export function isStrategyDue(interval: string, now: Date): boolean {
  if (!interval.endsWith("h")) return true;
  const n = Number(interval.slice(0, -1)) || 1;
  return now.getUTCHours() % n === 0;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schedule.ts src/schedule.test.ts
git commit -m "feat: schedule 新增 isStrategyDue(每小時排程判斷)"
```

---

### Task 4: `src/scan.ts` runScan 週期參數化

**Files:**
- Modify: `src/scan.ts:72-108`(`INTERVAL`/`HTF` 改為預設值、`htfScore` 與 `runScan` 收參數)
- Test: `src/scan.test.ts`(擴充)

**Interfaces:**
- Produces: `runScan(interval?: string, htf?: string): Promise<ScanRow[]>` — 不帶參數時行為與現行完全相同(4h/1d)。Task 6 以 `runScan(strategy.interval, strategy.htf)` 呼叫。

- [ ] **Step 1: 在 `src/scan.test.ts` 加失敗測試**

檔頭 import 增加 `runScan` 與 mock 工具:

```ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildScanRow, runScan } from "./scan.js";
```

新增 describe(fetch 一律拋錯 → 每幣 fail-soft 跳過,只驗發出的 URL):

```ts
afterEach(() => mock.restore());

describe("runScan 週期參數", () => {
  test("以 1h 參數呼叫 → kline 請求帶 interval=60", async () => {
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
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/scan.test.ts`
Expected: FAIL(現行 `runScan()` 不收參數,URL 是 `interval=240`)

- [ ] **Step 3: 修改 `src/scan.ts`**

`INTERVAL`/`HTF` 註解標明為 4h 策略預設值(export 保留,Task 6 前 `scripts/detect.ts` 仍在用):

```ts
export const INTERVAL = "4h"; // 預設策略週期(strategies.ts 可覆寫)
export const HTF = "1d"; // 預設大週期確認
```

`htfScore` 與 `runScan` 收參數:

```ts
async function htfScore(sym: string, htf: string): Promise<number | null> {
  try {
    const k = await fetchKlines("futures", sym, htf, 400);
    if (k.length < minBars(cfg)) return null;
    return evalAt(build(k, cfg), k.length - 1)?.score ?? null;
  } catch {
    return null;
  }
}

// 掃描全部 SYMBOLS,回結構化列。單幣失敗 fail-soft 跳過(不進結果)。
export async function runScan(interval: string = INTERVAL, htf: string = HTF): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const sym of SYMBOLS) {
    try {
      const klines = await fetchKlines("futures", sym, interval, 400);
      const ind = build(klines, cfg);
      const res = evalAt(ind, ind.klines.length - 2); // 最後一根已收盤 K 棒
      if (!res) continue;
      const [htfVal, oi, live] = await Promise.all([
        htfScore(sym, htf),
        evalOiDir(sym, interval, ind.klines),
        fetchLastPrice("futures", sym),
      ]);
      rows.push(buildScanRow(sym, res, htfVal, oi, live));
    } catch (e) {
      // fail-soft:單幣錯誤跳過,但記錄以利排障
      console.warn(`掃描 ${sym} 失敗:${(e as Error).message}`);
    }
  }
  return rows;
}
```

- [ ] **Step 4: 跑測試確認通過(含既有測試)**

Run: `bun test src/scan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts src/scan.test.ts
git commit -m "feat: runScan 週期參數化(預設 4h/1d 行為不變)"
```

---

### Task 5: `src/paper.ts` buildScorecard 策略標籤與基準

**Files:**
- Modify: `src/paper.ts:151-187`(`buildScorecard`)
- Test: `src/paper.test.ts`(擴充)

**Interfaces:**
- Produces: `buildScorecard(s: Summary, opens: OpenMark[], periodLabel: string, opts?: { strategyLabel?: string; baseline?: string }): string` — 不帶 `opts` 時輸出與現行完全相同。Task 7 以 `{ strategyLabel: strategy.name, baseline: strategy.baseline }` 呼叫。

- [ ] **Step 1: 在 `src/paper.test.ts` 的 `describe("buildScorecard")` 內加失敗測試**

檔頭 import 需含 `type Summary`(若尚未匯入):

```ts
import { buildScorecard, defaultPaperConfig, markToMarket, openPositions, settlePosition, sizePosition, type Summary, summarize } from "./paper.js";
```

(以檔案現有 import 為準,只補 `type Summary`。)

```ts
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `bun test src/paper.test.ts`
Expected: FAIL(`buildScorecard` 不收第 4 參數 → TS/斷言失敗)

- [ ] **Step 3: 修改 `src/paper.ts` 的 `buildScorecard`**

簽名與 `head`、`note` 改為:

```ts
// 組成績單(Slack 純文字)。opts 可帶策略標籤(標題)與基準註解(樣本足夠時顯示)。
export function buildScorecard(
  s: Summary,
  opens: OpenMark[],
  periodLabel: string,
  opts: { strategyLabel?: string; baseline?: string } = {},
): string {
```

`head` 的第一行改為:

```ts
  const title = opts.strategyLabel
    ? `📊 紙上交易成績單 · ${opts.strategyLabel} 策略 · ${periodLabel}`
    : `📊 紙上交易成績單 · ${periodLabel}`;
  const head =
    `${title}\n` +
    `權益 ${s.equity.toFixed(1)} / ${s.startEquity} USDT ` +
    `(${sign(pct)}${pct.toFixed(2)}%,已結 ${sign(s.realized)}${s.realized.toFixed(1)})`;
```

`note` 改為:

```ts
  const note =
    s.closed < 20
      ? "⚠️ 樣本 <20 筆,勝率/PF 尚無統計意義,請持續累積。"
      : (opts.baseline ??
        "基準:回測 4h avgR ≈ +0.10;明顯低於此值才代表策略在當前市場失效。");
```

- [ ] **Step 4: 跑測試確認通過**

Run: `bun test src/paper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/paper.ts src/paper.test.ts
git commit -m "feat: buildScorecard 支援策略標籤與基準註解"
```

---

### Task 6: `scripts/detect.ts` 依策略執行

**Files:**
- Modify: `scripts/detect.ts`(整檔改寫)

**Interfaces:**
- Consumes: Task 1 `strategyByName`/`intervalMsOf`、Task 4 `runScan(interval, htf)`。
- Produces: CLI `bun scripts/detect.ts [策略名]`(預設 `4h`)。Task 8 排程器以 `["scripts/detect.ts", s.name]` 呼叫。

- [ ] **Step 1: 改寫 `scripts/detect.ts`**

```ts
// 定時偵測進入點:bun scripts/detect.ts [策略名](預設 4h)。
// 掃描 → 篩有效機會 → 與上輪去重 →(依策略設定)推新機會到 Slack → 紙上交易記帳。
import { fetchKlines } from "../src/bybit.js";
import { diffNewOpportunities, filterOpportunities, keyOf } from "../src/detect.js";
import { defaultPaperConfig } from "../src/paper.js";
import { runPaper } from "../src/paper-run.js";
import { readLedger, writeLedger } from "../src/paper-state.js";
import { runScan } from "../src/scan.js";
import { buildSlackText, postMessage } from "../src/slack.js";
import { readActive, writeActive } from "../src/state.js";
import { intervalMsOf, strategyByName } from "../src/strategies.js";

const strategy = strategyByName(process.argv[2] ?? "4h");
// 環境變數覆寫只適用 4h(既有部署相容);1h 一律用策略設定路徑。
const is4h = strategy.name === "4h";
const STATE_PATH = is4h ? (process.env.STATE_PATH ?? strategy.statePath) : strategy.statePath;
const PAPER_PATH = is4h
  ? (process.env.PAPER_LEDGER_PATH ?? strategy.ledgerPath)
  : strategy.ledgerPath;
const PAPER_START = Number(process.env.PAPER_START_EQUITY ?? 2000);
const PAPER_ENABLED = process.env.PAPER_ENABLED !== "0";
const tag = `[${strategy.name}]`;

const rows = await runScan(strategy.interval, strategy.htf);

// 0 筆通常代表整輪 fetch 全數失敗/限流:不要重算去重狀態(否則會抹掉 active,
// 恢復後把仍有效的機會全部當新機會重推),直接結束並警示。
if (rows.length === 0) {
  console.warn(
    `${tag} [${new Date().toISOString()}] 掃描 0 筆(可能整輪 fetch 失敗或限流)— 跳過本輪,不更新去重狀態`,
  );
  process.exitCode = 1;
} else {
  const opps = filterOpportunities(rows);
  const prev = await readActive(STATE_PATH);
  const { news, active } = diffNewOpportunities(opps, prev);

  console.log(
    `${tag} [${new Date().toISOString()}] 掃描完成:有效機會 ${opps.length}、新機會 ${news.length}`,
  );

  // 預設把本輪全部有效機會寫入狀態;若推播失敗,把新機會的 key 撤回,下輪可補推。
  let committed = active;
  if (strategy.pushSignals && news.length > 0) {
    try {
      await postMessage(buildSlackText(news));
      console.log(
        `${tag} 已推播 ${news.length} 則到 Slack:${news.map((o) => `${o.symbol}:${o.dir}`).join(", ")}`,
      );
    } catch (e) {
      const newsKeys = new Set(news.map((o) => keyOf(o)));
      committed = active.filter((k) => !newsKeys.has(k));
      console.error(`${tag} Slack 推播失敗:${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  await writeActive(STATE_PATH, committed);

  // 紙上交易記帳:結算未結部位 + 用本輪「新機會」開新部位。失敗不影響訊號推播。
  if (PAPER_ENABLED) {
    try {
      const cfg = {
        ...defaultPaperConfig(),
        startEquity: PAPER_START,
        intervalMs: intervalMsOf(strategy.interval),
      };
      const ledger = await readLedger(PAPER_PATH, PAPER_START);
      const result = await runPaper(
        news,
        ledger,
        cfg,
        (sym) => fetchKlines("futures", sym, strategy.interval, 400),
        Date.now(),
      );
      await writeLedger(PAPER_PATH, result.ledger);
      const { summary: s, opened, closed } = result;
      console.log(
        `${tag} [紙上交易] 新開 ${opened.length}、本輪結算 ${closed.length}｜` +
          `已結 ${s.closed} 勝率 ${(s.winRate * 100).toFixed(0)}% avgR ${s.avgR.toFixed(2)} ` +
          `PF ${s.profitFactor === Number.POSITIVE_INFINITY ? "∞" : s.profitFactor.toFixed(2)}｜` +
          `權益 ${s.equity.toFixed(1)} USDT`,
      );
    } catch (e) {
      console.error(`${tag} [紙上交易] 記帳失敗:${(e as Error).message}`);
    }
  }
}
```

注意與現行版的差異只有:策略名參數、路徑解析、`runScan(interval, htf)`、
`strategy.pushSignals &&` 推播條件、`intervalMs` 與 `fetchKlines` 用策略週期、log 加 `tag`。

- [ ] **Step 2: 型別檢查 + 全測試**

Run: `bun run type-check && bun test`
Expected: 皆 PASS

- [ ] **Step 3: 驗證未知策略名會擋下**

Run: `bun scripts/detect.ts 2h; echo "exit=$?"`
Expected: 拋錯訊息含「未知策略:2h」,非零 exit(不打任何網路請求)

- [ ] **Step 4: Commit**

```bash
git add scripts/detect.ts
git commit -m "feat: detect.ts 依策略名執行(4h 預設行為不變)"
```

---

### Task 7: `scripts/paper-report.ts` 依策略出成績單

**Files:**
- Modify: `scripts/paper-report.ts`(整檔改寫)

**Interfaces:**
- Consumes: Task 1 `strategyByName`、Task 2 `postMessage(text, channelId)`、Task 5 `buildScorecard(..., opts)`。
- Produces: CLI `bun scripts/paper-report.ts [策略名] [--dry]`(預設 `4h`)。Task 8 排程器以 `["scripts/paper-report.ts", s.name]` 呼叫。

- [ ] **Step 1: 改寫 `scripts/paper-report.ts`**

```ts
// 紙上交易成績單:讀帳 → 未結部位以現價評估 → 組成績單並推該策略的 Slack 頻道。
// 用法:bun scripts/paper-report.ts [策略名] [--dry](預設 4h;--dry 只印不推)
import { fetchLastPrice } from "../src/bybit.js";
import {
  buildScorecard,
  defaultPaperConfig,
  markToMarket,
  type OpenMark,
  summarize,
} from "../src/paper.js";
import { readLedger } from "../src/paper-state.js";
import { postMessage } from "../src/slack.js";
import { strategyByName } from "../src/strategies.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const strategy = strategyByName(args.find((a) => !a.startsWith("--")) ?? "4h");
// 環境變數覆寫只適用 4h(既有部署相容);1h 一律用策略設定路徑。
const PAPER_PATH =
  strategy.name === "4h"
    ? (process.env.PAPER_LEDGER_PATH ?? strategy.ledgerPath)
    : strategy.ledgerPath;
const PAPER_START = Number(process.env.PAPER_START_EQUITY ?? 2000);

const cfg = { ...defaultPaperConfig(), startEquity: PAPER_START };
const ledger = await readLedger(PAPER_PATH, PAPER_START);

// 未結部位以現價評估浮動損益(取不到價就跳過該筆)
const opens: OpenMark[] = [];
for (const p of ledger.positions.filter((x) => x.status === "OPEN")) {
  const price = await fetchLastPrice("futures", p.symbol);
  if (price == null) continue;
  opens.push({
    symbol: p.symbol,
    dir: p.dir,
    entry: p.entry,
    price,
    unrealized: markToMarket(p, price, cfg),
  });
}

const summary = summarize(ledger.positions, cfg);
const period = `截至 ${new Date().toISOString().slice(0, 10)}`;
const text = buildScorecard(summary, opens, period, {
  strategyLabel: strategy.name,
  baseline: strategy.baseline,
});

console.log(text);
if (!dry) {
  try {
    const channel = process.env[strategy.channelEnv];
    if (!channel) throw new Error(`缺少 ${strategy.channelEnv} 環境變數`);
    await postMessage(text, channel);
    console.log(`\n已推播 ${strategy.name} 成績單到 Slack。`);
  } catch (e) {
    console.error(`推播失敗:${(e as Error).message}`);
    process.exitCode = 1;
  }
}
```

注意:4h 成績單標題從此也會帶「· 4h 策略」——兩頻道並行後這是刻意的,方便辨識。

- [ ] **Step 2: 型別檢查 + dry-run 驗證**

Run: `bun run type-check && bun scripts/paper-report.ts 1h --dry`
Expected: type-check PASS;印出「📊 紙上交易成績單 · 1h 策略 · 截至 …」
(1h 帳本尚不存在 → fail-soft 空帳,已結 0 筆、警語),不推 Slack。

Run: `bun scripts/paper-report.ts --dry`
Expected: 印出 4h 成績單(標題含「4h 策略」),讀的是現有 `data/paper-ledger.json`。

- [ ] **Step 3: Commit**

```bash
git add scripts/paper-report.ts
git commit -m "feat: paper-report 依策略出成績單並推對應頻道"
```

---

### Task 8: `scripts/scheduler.ts` 每小時觸發雙策略

**Files:**
- Modify: `scripts/scheduler.ts`(整檔改寫)

**Interfaces:**
- Consumes: Task 3 `isStrategyDue`、既有 `nextRunTime`/`shouldPushReport`、Task 1 `STRATEGIES`、Task 6/7 的 CLI。

- [ ] **Step 1: 改寫 `scripts/scheduler.ts`**

```ts
// 常駐排程器:每小時整點後 2 分(UTC)醒來,依 isStrategyDue 執行輪到的策略
// (1h 每小時、4h 逢 UTC 0/4/8/12/16/20)。每策略以子行程跑 detect,互不拖垮。
// 每天 UTC0 那輪後,各策略成績單推各自的 Slack 頻道。
// 可用環境變數 SCAN_EVERY_SECONDS 覆寫為「每 N 秒全策略執行」模式(測試用)。
import { isStrategyDue, nextRunTime, shouldPushReport } from "../src/schedule.js";
import { STRATEGIES } from "../src/strategies.js";

const RUN_HOURS = Array.from({ length: 24 }, (_, h) => h);
const RUN_MINUTE = 2;
const everySeconds = Number(process.env.SCAN_EVERY_SECONDS ?? 0);

if (everySeconds > 0) {
  console.log(`[排程器啟動] 測試模式:每 ${everySeconds} 秒執行全部策略`);
} else {
  const names = STRATEGIES.map((s) => `${s.name}(每 ${s.interval})`).join("、");
  console.log(`[排程器啟動] 每小時整點後 ${RUN_MINUTE} 分(UTC)檢查:${names}`);
}

async function runScript(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await proc.exited;
}

while (true) {
  let waitMs: number;
  let label: string;
  if (everySeconds > 0) {
    waitMs = everySeconds * 1000;
    label = `${everySeconds} 秒後`;
  } else {
    const now = new Date();
    const next = nextRunTime(now, RUN_HOURS, RUN_MINUTE);
    waitMs = next.getTime() - now.getTime();
    label = `${next.toISOString()}(約 ${Math.round(waitMs / 60000)} 分後)`;
  }
  console.log(`下次掃描:${label}`);
  await Bun.sleep(waitMs);

  const now = new Date();
  for (const s of STRATEGIES) {
    if (everySeconds === 0 && !isStrategyDue(s.interval, now)) continue;
    console.log(`[${new Date().toISOString()}] 觸發掃描(${s.name})…`);
    await runScript(["scripts/detect.ts", s.name]);
  }

  // 每天 UTC 00 點那輪掃描後,各策略成績單推各自頻道(日報)
  if (everySeconds === 0 && shouldPushReport(now)) {
    for (const s of STRATEGIES) {
      console.log(`[${new Date().toISOString()}] 推播紙上交易日報(${s.name})…`);
      await runScript(["scripts/paper-report.ts", s.name]);
    }
  }
}
```

注意:`shouldPushReport` 判斷改用「本輪喚醒時刻」`now`(掃描前取樣),
避免掃描跑超過整點導致誤判——1h 掃描 14 幣通常 <1 分鐘,但不賭它。

- [ ] **Step 2: 型別檢查 + 全測試 + biome**

Run: `bun run check && bun test`
Expected: 皆 PASS

- [ ] **Step 3: 測試模式煙霧測試(打真網路,觀察兩策略各跑一輪)**

Run: `SCAN_EVERY_SECONDS=5 PAPER_ENABLED=0 timeout 90 bun scripts/scheduler.ts; echo done`
Expected: 先印「測試模式」,~5 秒後依序出現「觸發掃描(4h)…」與「觸發掃描(1h)…」,
各自印出「[4h] 掃描完成…」「[1h] 掃描完成…」(有效機會數可為 0)。
`PAPER_ENABLED=0` 避免煙霧測試污染正式帳本。90 秒後 timeout 收工。
注意:此模式會推播真的 Slack 訊號(若 4h 恰有新機會);介意就先
`SLACK_CHANNEL_ID` 指向測試頻道再跑,結束後把 `data/signal-state.json` 還原
(`git checkout -- data` 若該檔有版控;無版控則跑前先備份)。

- [ ] **Step 4: Commit**

```bash
git add scripts/scheduler.ts
git commit -m "feat: 排程器每小時觸發,並行執行 4h/1h 策略"
```

---

### Task 9: 收尾——文件與最終驗證

**Files:**
- Modify: `.dev.vars.example`(若其中列有 Slack 變數則補 `SLACK_CHANNEL_ID_1H`;沒有就跳過)
- Modify: `docs/superpowers/specs/2026-07-16-parallel-1h-strategy-design.md`(狀態改「已實作」)

- [ ] **Step 1: 檢查 `.dev.vars.example` 是否需要補環境變數說明**

Run: `rg -n "SLACK" .dev.vars.example .env.example 2>/dev/null`
若有列 `SLACK_CHANNEL_ID`,同格式補一行:

```
SLACK_CHANNEL_ID_1H=C0XXXXXXX   # 1h 策略成績單頻道
```

- [ ] **Step 2: 最終驗證**

Run: `bun run check && bun test`
Expected: 全 PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: 並行 1h 紙上交易策略收尾(文件與環境變數範例)"
```

- [ ] **Step 4: 部署提醒(人工)**

提醒使用者:
1. 開新 Slack 頻道並把 bot 邀進去(`/invite @bot`)。
2. 在跑排程器的環境設 `SLACK_CHANNEL_ID_1H=<新頻道 ID>`。
3. 重啟 `bun scripts/scheduler.ts` 常駐行程,讓新排程(每小時)生效。
