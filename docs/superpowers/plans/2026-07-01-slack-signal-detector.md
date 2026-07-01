# Slack 定時偵測推播器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本機 Docker 容器每 4h 用專案訊號引擎掃描主流幣,發現新的三重確認進場機會就推播到 Slack。

**Architecture:** 抽出共用掃描核心 `src/scan.ts`(重用現有引擎),純函式做「機會篩選 / 停損停利 / 去重 diff」置於 `src/detect.ts`,Slack 客戶端 `src/slack.ts`,狀態存取 `src/state.ts`,由薄進入點 `scripts/detect.ts` 串接。容器內用 supercronic 依 crontab 排程。

**Tech Stack:** TypeScript + ESM、Bun、零 runtime 相依(只用 Web `fetch` 與 `node:fs/promises`)、Docker(`oven/bun` + supercronic)、Slack `chat.postMessage`。

## Global Constraints

- TypeScript + ESM,**零 runtime npm 相依**;只用 Workers/Web 平台 API(`fetch`)與 Bun 內建。
- import 一律用 `.js` specifier(TS `verbatimModuleSyntax`)。
- 註解與所有使用者可見字串為**繁體中文**。
- 測試用 `bun:test`,以 `mock()` stub `globalThis.fetch`(依 URL 子字串路由),`afterEach(() => mock.restore())`。
- `Direction = { Long: "LONG", Short: "SHORT", Neutral: "NEUTRAL" }`(`src/types.ts`)。
- 停損停利:做空 停損=price+2×ATR、目標=price−3×ATR;做多 停損=price−2×ATR、目標=price+3×ATR。
- 密鑰只從環境變數讀,絕不寫入進 git 的檔案。`.env` 與 `data/` 需 gitignore。
- 提交前門檻:`bun run check`(biome + tsc)與 `bun test` 需通過。
- 目標平台 arm64(colima/Apple Silicon)。

---

### Task 1: 掃描核心資料結構與純轉換 `src/scan.ts`

**Files:**
- Create: `src/scan.ts`
- Test: `src/scan.test.ts`

**Interfaces:**
- Consumes: `Result`、`Regime`、`DirectionValue`、`Direction`(`src/types.js`)。
- Produces:
  - `interface ScanRow { symbol; dir: DirectionValue; effective: DirectionValue | "DOWNGRADED"; score: number; regime: Regime; adx: number; htf1d: number | null; oi: number | null; price: number; atr: number; htfConflict: boolean; oiConflict: boolean }`
  - `buildScanRow(symbol: string, res: Result, htf: number | null, oi: number | null, live: number | null): ScanRow`

- [ ] **Step 1: Write the failing test**

`src/scan.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildScanRow } from "./scan.js";
import { Direction } from "./types.js";
import type { Result } from "./types.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/scan.test.ts`
Expected: FAIL(`buildScanRow` 未定義 / 模組不存在)。

- [ ] **Step 3: Write minimal implementation**

`src/scan.ts`:
```ts
// 掃描核心:重用訊號引擎的共用邏輯,回結構化 ScanRow,供列印腳本與偵測器共用。
import { Direction } from "./types.js";
import type { DirectionValue, Regime, Result } from "./types.js";

export interface ScanRow {
  symbol: string;
  dir: DirectionValue; // 引擎原始方向
  effective: DirectionValue | "DOWNGRADED"; // 套用衝突降級後的有效方向
  score: number;
  regime: Regime;
  adx: number;
  htf1d: number | null;
  oi: number | null; // -1 | 0 | 1
  price: number; // 即時價;取不到退回收盤價
  atr: number;
  htfConflict: boolean;
  oiConflict: boolean;
}

// 純函式:由引擎輸出組出一列掃描結果(與 scan-market 的衝突降級規則一致)。
export function buildScanRow(
  symbol: string,
  res: Result,
  htf: number | null,
  oi: number | null,
  live: number | null,
): ScanRow {
  const dir = res.direction;
  const htfConflict =
    htf != null &&
    ((dir === Direction.Long && htf < 0) || (dir === Direction.Short && htf > 0));
  const oiConflict =
    oi != null &&
    ((dir === Direction.Long && oi < 0) || (dir === Direction.Short && oi > 0));
  const effective =
    dir !== Direction.Neutral && (htfConflict || oiConflict) ? "DOWNGRADED" : dir;
  return {
    symbol,
    dir,
    effective,
    score: res.score,
    regime: res.regime,
    adx: res.adx,
    htf1d: htf,
    oi,
    price: live ?? res.price,
    atr: res.atr,
    htfConflict,
    oiConflict,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/scan.test.ts`
Expected: PASS(5 個測試通過)。

- [ ] **Step 5: Commit**

```bash
git add src/scan.ts src/scan.test.ts
git commit -m "feat: 掃描核心 buildScanRow 純函式與測試"
```

---

### Task 2: 掃描編排 `runScan` 並重構 `scan-market.ts`

**Files:**
- Modify: `src/scan.ts`(新增 `runScan`)
- Modify: `scripts/scan-market.ts`(改用 `runScan`,輸出格式不變)

**Interfaces:**
- Consumes: `fetchKlines`、`fetchLastPrice`(`src/bybit.js`);`evalOiDir`(`src/oi.js`);`build`、`defaultConfig`、`evalAt`、`minBars`(`src/signal.js`);`buildScanRow`(Task 1)。
- Produces: `runScan(): Promise<ScanRow[]>`;`SYMBOLS`、`INTERVAL`、`HTF` 匯出常數。

- [ ] **Step 1: 在 `src/scan.ts` 新增編排函式與常數**

於 `src/scan.ts` 檔尾追加:
```ts
import { fetchKlines, fetchLastPrice } from "./bybit.js";
import { evalOiDir } from "./oi.js";
import { build, defaultConfig, evalAt, minBars } from "./signal.js";

export const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT",
  "TONUSDT", "LTCUSDT", "BCHUSDT", "NEARUSDT", "APTUSDT",
];
export const INTERVAL = "4h";
export const HTF = "1d";

const cfg = defaultConfig();

async function htfScore(sym: string): Promise<number | null> {
  try {
    const k = await fetchKlines("futures", sym, HTF, 400);
    if (k.length < minBars(cfg)) return null;
    return evalAt(build(k, cfg), k.length - 1)?.score ?? null;
  } catch {
    return null;
  }
}

// 掃描全部 SYMBOLS,回結構化列。單幣失敗 fail-soft 跳過(不進結果)。
export async function runScan(): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const sym of SYMBOLS) {
    try {
      const klines = await fetchKlines("futures", sym, INTERVAL, 400);
      const ind = build(klines, cfg);
      const res = evalAt(ind, ind.klines.length - 2); // 最後一根已收盤 K 棒
      if (!res) continue;
      const [htf, oi, live] = await Promise.all([
        htfScore(sym),
        evalOiDir(sym, INTERVAL, ind.klines),
        fetchLastPrice("futures", sym),
      ]);
      rows.push(buildScanRow(sym, res, htf, oi, live));
    } catch {
      // fail-soft:單幣錯誤跳過
    }
  }
  return rows;
}
```

- [ ] **Step 2: 重構 `scripts/scan-market.ts` 改用 `runScan`(輸出不變)**

將 `scripts/scan-market.ts` 全檔換為:
```ts
// 臨時掃描:用本專案訊號引擎跑主流幣 4h 訊號 + 1d 大週期確認 + OI 確認。
import { runScan } from "../src/scan.js";

for (const r of await runScan()) {
  const eff = r.effective === "DOWNGRADED" ? "觀望(降級)" : r.effective;
  console.log(
    [
      r.symbol,
      eff,
      `score=${r.score.toFixed(1)}`,
      `4h=${r.regime}`,
      `adx=${r.adx.toFixed(0)}`,
      `htf1d=${r.htf1d?.toFixed(1) ?? "—"}`,
      `oi=${r.oi ?? "—"}`,
      `price=${r.price}`,
      `atr=${r.atr.toFixed(r.atr < 1 ? 5 : 2)}`,
      r.htfConflict ? "⚠HTF反向" : "",
      r.oiConflict ? "⚠OI反向" : "",
    ].join("\t"),
  );
}
```

- [ ] **Step 3: 型別檢查 + 冒煙測試(需連外網)**

Run: `bun run type-check`
Expected: 無錯誤。

Run: `bun run scripts/scan-market.ts`
Expected: 印出 15 行(每幣一行,tab 分隔),格式與重構前一致。

- [ ] **Step 4: Commit**

```bash
git add src/scan.ts scripts/scan-market.ts
git commit -m "refactor: scan-market 改用共用 runScan 核心"
```

---

### Task 3: 機會篩選、停損停利、去重 diff `src/detect.ts`

**Files:**
- Create: `src/detect.ts`
- Test: `src/detect.test.ts`

**Interfaces:**
- Consumes: `ScanRow`(`src/scan.js`);`Regime`(`src/types.js`)。
- Produces:
  - `interface Opportunity { symbol: string; dir: "LONG" | "SHORT"; entry: number; stop: number; target: number; score: number; regime: Regime; adx: number; htf1d: number | null; oi: number | null }`
  - `computeLevels(dir: "LONG" | "SHORT", price: number, atr: number): { stop: number; target: number }`
  - `filterOpportunities(rows: ScanRow[]): Opportunity[]`
  - `keyOf(o: Opportunity): string`
  - `diffNewOpportunities(opps: Opportunity[], prevActive: string[]): { news: Opportunity[]; active: string[] }`

- [ ] **Step 1: Write the failing test**

`src/detect.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/detect.test.ts`
Expected: FAIL(模組/函式未定義)。

- [ ] **Step 3: Write minimal implementation**

`src/detect.ts`:
```ts
// 偵測純邏輯:把掃描列篩成可進場機會、算停損停利、與上輪狀態做去重 diff。
import type { ScanRow } from "./scan.js";
import type { Regime } from "./types.js";

export interface Opportunity {
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  score: number;
  regime: Regime;
  adx: number;
  htf1d: number | null;
  oi: number | null;
}

// 四捨五入到 2 位(價格單位一致,避免浮點雜訊)。
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 停損停利:2×ATR 停損、3×ATR 目標,方向決定加減。
export function computeLevels(
  dir: "LONG" | "SHORT",
  price: number,
  atr: number,
): { stop: number; target: number } {
  return dir === "SHORT"
    ? { stop: round2(price + 2 * atr), target: round2(price - 3 * atr) }
    : { stop: round2(price - 2 * atr), target: round2(price + 3 * atr) };
}

// 只保留有效方向(通過三重確認)的列,轉成含進出場位的機會。
export function filterOpportunities(rows: ScanRow[]): Opportunity[] {
  const opps: Opportunity[] = [];
  for (const r of rows) {
    if (r.effective !== "LONG" && r.effective !== "SHORT") continue;
    const dir = r.effective;
    const { stop, target } = computeLevels(dir, r.price, r.atr);
    opps.push({
      symbol: r.symbol,
      dir,
      entry: r.price,
      stop,
      target,
      score: r.score,
      regime: r.regime,
      adx: r.adx,
      htf1d: r.htf1d,
      oi: r.oi,
    });
  }
  return opps;
}

export function keyOf(o: Opportunity): string {
  return `${o.symbol}:${o.dir}`;
}

// 與上輪 active 比對:news = 本輪新出現的;active = 本輪全部 key(消失者自動移除)。
export function diffNewOpportunities(
  opps: Opportunity[],
  prevActive: string[],
): { news: Opportunity[]; active: string[] } {
  const prev = new Set(prevActive);
  const news = opps.filter((o) => !prev.has(keyOf(o)));
  const active = opps.map(keyOf);
  return { news, active };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/detect.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/detect.ts src/detect.test.ts
git commit -m "feat: 機會篩選、停損停利與去重 diff 純邏輯"
```

---

### Task 4: Slack 客戶端與訊息組裝 `src/slack.ts`

**Files:**
- Create: `src/slack.ts`
- Test: `src/slack.test.ts`

**Interfaces:**
- Consumes: `Opportunity`(`src/detect.js`)。
- Produces:
  - `buildSlackText(opps: Opportunity[]): string`
  - `postMessage(text: string): Promise<void>`(讀 env `SLACK_BOT_TOKEN`、`SLACK_CHANNEL_ID`)

- [ ] **Step 1: Write the failing test**

`src/slack.test.ts`:
```ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildSlackText, postMessage } from "./slack.js";
import type { Opportunity } from "./detect.js";

afterEach(() => mock.restore());

const link: Opportunity = {
  symbol: "LINKUSDT", dir: "SHORT", entry: 7.16, stop: 7.42, target: 6.77,
  score: -88, regime: "趨勢", adx: 36, htf1d: -86.9, oi: -1,
};

describe("buildSlackText", () => {
  test("含幣種、方向、進場/停損/目標與免責", () => {
    const text = buildSlackText([link]);
    expect(text).toContain("LINKUSDT");
    expect(text).toContain("做空");
    expect(text).toContain("7.16");
    expect(text).toContain("7.42");
    expect(text).toContain("6.77");
    expect(text).toContain("2×ATR");
    expect(text).toContain("非投資建議");
    expect(text).toContain("1 個"); // 摘要數量
  });
});

describe("postMessage", () => {
  test("POST 到 chat.postMessage,body 帶 env 頻道與 text", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      captured = { url, body: String(init.body) };
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await postMessage("哈囉");

    expect(captured!.url).toContain("chat.postMessage");
    const body = JSON.parse(captured!.body);
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("哈囉");
  });

  test("Slack 回 ok:false → 拋錯", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" })),
    ) as unknown as typeof fetch;

    expect(postMessage("x")).rejects.toThrow("channel_not_found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/slack.test.ts`
Expected: FAIL(模組/函式未定義)。

- [ ] **Step 3: Write minimal implementation**

`src/slack.ts`:
```ts
// Slack 通知:chat.postMessage(bot token)。零相依,只用 fetch。密鑰由環境變數提供。
import type { Opportunity } from "./detect.js";

const dirLabel = (dir: "LONG" | "SHORT") => (dir === "SHORT" ? "做空" : "做多");
const dirEmoji = (dir: "LONG" | "SHORT") => (dir === "SHORT" ? "🔴" : "🟢");
const fmtHtf = (n: number | null) => (n == null ? "—" : n.toFixed(1));

// 組一則 Slack 純文字訊息:摘要 + 每個機會一段 + 免責。
export function buildSlackText(opps: Opportunity[]): string {
  const header = `⏰ 4h 掃描 · 發現 ${opps.length} 個新進場機會`;
  const blocks = opps.map(
    (o) =>
      `${dirEmoji(o.dir)} *${o.symbol} ${dirLabel(o.dir)}*\n` +
      `   4h${o.regime} · ADX ${o.adx.toFixed(0)} · 日線 ${fmtHtf(o.htf1d)} · OI ${o.oi ?? "—"}\n` +
      `   進場 ${o.entry} ｜ 停損 ${o.stop} (2×ATR) ｜ 目標 ${o.target} (3×ATR)`,
  );
  const footer = "⚠️ 技術面訊號,非投資建議。務必照停損操作。";
  return [header, "", ...blocks, "", footer].join("\n");
}

// 發送到 Slack。缺 env 或 Slack 回 ok:false 皆拋錯,由呼叫端 log。
export async function postMessage(text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    throw new Error("缺少 SLACK_BOT_TOKEN 或 SLACK_CHANNEL_ID 環境變數");
  }
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack 發送失敗:${data.error ?? "unknown"}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/slack.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/slack.ts src/slack.test.ts
git commit -m "feat: Slack 客戶端與推播訊息組裝"
```

---

### Task 5: 去重狀態存取 `src/state.ts`

**Files:**
- Create: `src/state.ts`
- Test: `src/state.test.ts`

**Interfaces:**
- Produces:
  - `readActive(path: string): Promise<string[]>`(檔案不存在或解析失敗 → `[]`)
  - `writeActive(path: string, active: string[]): Promise<void>`(自動建目錄,寫 `{ active, updatedAt }`)

- [ ] **Step 1: Write the failing test**

`src/state.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActive, writeActive } from "./state.js";

const dir = join(tmpdir(), "csb-state-test");
const path = join(dir, "signal-state.json");

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state", () => {
  test("檔案不存在 → 回空陣列", async () => {
    expect(await readActive(join(dir, "nope.json"))).toEqual([]);
  });

  test("write 後 read 可還原(自動建目錄)", async () => {
    await writeActive(path, ["LINKUSDT:SHORT", "BNBUSDT:SHORT"]);
    expect((await readActive(path)).sort()).toEqual(["BNBUSDT:SHORT", "LINKUSDT:SHORT"]);
  });

  test("內容毀損 → 回空陣列(fail-soft)", async () => {
    await writeActive(path, []); // 先建目錄
    await Bun.write(path, "{壞掉的 json");
    expect(await readActive(path)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/state.test.ts`
Expected: FAIL(模組/函式未定義)。

- [ ] **Step 3: Write minimal implementation**

`src/state.ts`:
```ts
// 去重狀態:以 JSON 檔記錄上輪有效機會的 key 集合。fail-soft:讀不到/壞掉都當空。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readActive(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { active?: unknown };
    return Array.isArray(parsed.active) ? (parsed.active as string[]) : [];
  } catch {
    return [];
  }
}

export async function writeActive(path: string, active: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify({ active, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(path, body, "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/state.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "feat: 去重狀態 JSON 存取"
```

---

### Task 6: 偵測進入點 `scripts/detect.ts` 與 npm script

**Files:**
- Create: `scripts/detect.ts`
- Modify: `package.json`(新增 `"detect"` script)

**Interfaces:**
- Consumes: `runScan`(`src/scan.js`);`filterOpportunities`、`diffNewOpportunities`(`src/detect.js`);`buildSlackText`、`postMessage`(`src/slack.js`);`readActive`、`writeActive`(`src/state.js`)。
- Produces: 可執行進入點(無匯出)。

- [ ] **Step 1: 撰寫進入點**

`scripts/detect.ts`:
```ts
// 定時偵測進入點:掃描 → 篩有效機會 → 與上輪去重 → 只推新機會到 Slack。
import { diffNewOpportunities, filterOpportunities } from "../src/detect.js";
import { runScan } from "../src/scan.js";
import { buildSlackText, postMessage } from "../src/slack.js";
import { readActive, writeActive } from "../src/state.js";

const STATE_PATH = process.env.STATE_PATH ?? "./data/signal-state.json";

const rows = await runScan();
const opps = filterOpportunities(rows);
const prev = await readActive(STATE_PATH);
const { news, active } = diffNewOpportunities(opps, prev);
await writeActive(STATE_PATH, active);

console.log(`[${new Date().toISOString()}] 掃描完成:有效機會 ${opps.length}、新機會 ${news.length}`);

if (news.length > 0) {
  try {
    await postMessage(buildSlackText(news));
    console.log(`已推播 ${news.length} 則到 Slack:${news.map((o) => `${o.symbol}:${o.dir}`).join(", ")}`);
  } catch (e) {
    console.error(`Slack 推播失敗:${(e as Error).message}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: 在 `package.json` scripts 新增 detect**

於 `package.json` 的 `"scripts"` 內、`"richmenu"` 那行後面加入:
```json
    "detect": "bun scripts/detect.ts",
```

- [ ] **Step 3: 型別檢查 + 乾跑(不推 Slack)**

Run: `bun run type-check`
Expected: 無錯誤。

Run: `SLACK_BOT_TOKEN=x SLACK_CHANNEL_ID=x STATE_PATH=./data/test-state.json bun scripts/detect.ts`
Expected: 印「掃描完成:有效機會 N、新機會 M」;若 M>0 會嘗試推 Slack 並因假 token 印「Slack 推播失敗:…」(屬預期,驗證流程有跑通)。之後刪掉 `./data/test-state.json`。

- [ ] **Step 4: Commit**

```bash
git add scripts/detect.ts package.json
git commit -m "feat: 偵測進入點 detect.ts 與 npm script"
```

---

### Task 7: Docker 佈署 + Makefile(supercronic 常駐)

依 `../django-ninja-project-tree` 慣例:compose 置於 `docker/` 子目錄、用 `.env.local`、以 Makefile 封裝 docker 指令。

**Files:**
- Create: `docker/Dockerfile`
- Create: `docker/crontab`
- Create: `docker/docker-compose.yml`
- Create: `Makefile`
- Create: `.env.local.example`
- Create: `.dockerignore`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `scripts/detect.ts`、`package.json`、`bun.lock`。

- [ ] **Step 1: 更新 `.gitignore`**

在 `.gitignore` 檔尾追加:
```
.env.local
data
```

- [ ] **Step 2: 建立 `.env.local.example`(進 git 的範本,不含真值)**

`.env.local.example`:
```
# Slack bot token(xoxb-...);複製成 .env.local 再填真值,勿提交真實值。
SLACK_BOT_TOKEN=
# 目標頻道 ID(#cry)
SLACK_CHANNEL_ID=C0BEBHYB56E
```

- [ ] **Step 3: 建立 `docker/crontab`(UTC,對齊 4h 收棒後 2 分)**

`docker/crontab`:
```
# 每 4h 收棒後 2 分鐘掃描一次(UTC)
2 0,4,8,12,16,20 * * * cd /app && bun scripts/detect.ts
```

- [ ] **Step 4: 建立 `.dockerignore`**

`.dockerignore`:
```
node_modules
.git
.env.local
data
dist
.wrangler
*.log
```

- [ ] **Step 5: 建立 `docker/Dockerfile`(oven/bun + supercronic arm64)**

`docker/Dockerfile`:
```dockerfile
FROM oven/bun:1

WORKDIR /app

# supercronic:容器內 cron 排程器(靜態單一 binary)。arm64(colima/Apple Silicon)。
ENV SUPERCRONIC_VERSION=v0.2.33
ADD https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-arm64 /usr/local/bin/supercronic
RUN chmod +x /usr/local/bin/supercronic

# 相依(依 lockfile,零 runtime 相依但仍需 devDeps 供 bun 執行 TS)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# 排程器前景執行,容器常駐
CMD ["supercronic", "/app/docker/crontab"]
```

- [ ] **Step 6: 建立 `docker/docker-compose.yml`**

`context: ..` 指向專案根(compose 檔在 `docker/` 內)。

`docker/docker-compose.yml`:
```yaml
services:
  detector:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    env_file: ../.env.local
    environment:
      - STATE_PATH=/app/data/signal-state.json
    volumes:
      - ../data:/app/data
    restart: unless-stopped
```

- [ ] **Step 7: 建立 `Makefile`(封裝 docker 指令,繁中 help)**

`Makefile`:
```makefile
.PHONY: help up down build rebuild logs run docker-clean

COMPOSE = docker compose -f docker/docker-compose.yml

help:
	@echo "========================================"
	@echo "  crypto-signal-bot 偵測推播器 (Docker)"
	@echo "========================================"
	@echo ""
	@echo "  make up            - 建構並啟動常駐偵測器 (每 4h 掃描)"
	@echo "  make down          - 停止容器"
	@echo "  make build         - 僅建構映像 (不啟動)"
	@echo "  make rebuild       - 重新建構並啟動 (改 Dockerfile/程式碼後用)"
	@echo "  make logs          - 追蹤容器日誌"
	@echo "  make run           - 立即跑一次掃描 (不等 cron,用於測試)"
	@echo "  make docker-clean  - 停止並清理資料卷與本地 data/"
	@echo ""
	@echo "首次使用:cp .env.local.example .env.local 後填入 SLACK_BOT_TOKEN"

up:
	$(COMPOSE) up -d --build
	@echo ""
	@echo "偵測器已啟動!每 4h(收棒後 2 分,UTC)掃描一次,有新機會推 Slack #cry"
	@echo "  查看日誌:make logs"

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build

rebuild:
	$(COMPOSE) up -d --build

logs:
	$(COMPOSE) logs -f

run:
	$(COMPOSE) run --rm detector bun scripts/detect.ts

docker-clean:
	$(COMPOSE) down -v
	rm -rf data/
	@echo "Docker 資料卷與本地 data/ 已清理"
```

- [ ] **Step 8: 建置與驗證(需真 `.env.local`)**

先建立本機 `.env.local`(不進 git):
```bash
cp .env.local.example .env.local
# 編輯 .env.local 填入真實 SLACK_BOT_TOKEN
```

立即跑一次驗證(不等 cron):
```bash
make run
```
Expected: 容器內印「掃描完成:…」;若當下有新機會,Slack `#cry` 收到推播。

啟動常駐排程並看日誌:
```bash
make up
make logs
```
Expected: 容器持續運行,每到 4h 邊界後 2 分鐘執行一次。

- [ ] **Step 9: Commit**

```bash
git add docker/ Makefile .env.local.example .dockerignore .gitignore
git commit -m "feat: Docker + supercronic 常駐偵測器與 Makefile"
```

---

## Self-Review

**Spec coverage:**
- 執行環境(Docker + supercronic 常駐,Makefile 啟動)→ Task 7 ✅
- 頻率(每 4h 收棒後 2 分,UTC)→ Task 7 `docker/crontab` ✅
- 偵測範圍(15 幣、4h、1d HTF)→ Task 2 `SYMBOLS/INTERVAL/HTF` ✅
- 觸發(有效方向且新出現)→ Task 3 `filterOpportunities` + `diffNewOpportunities` ✅
- Slack `chat.postMessage` 到 `C0BEBHYB56E` → Task 4 + Task 7 `.env.local` ✅
- 密鑰只讀 env、不進 git → Task 4 `postMessage`、Task 7 `.gitignore`/`.env.local.example` ✅
- Makefile 封裝 docker(參考 django-ninja-project-tree,compose 置 `docker/`、用 `.env.local`)→ Task 7 `Makefile` ✅
- `src/scan.ts` 共用核心、`scan-market.ts` 輸出不變 → Task 1 + Task 2 ✅
- 去重狀態 JSON、volume 掛載 → Task 5 + Task 7 compose volume ✅
- 推播內容(方向/進場/2×ATR停損/3×ATR目標/context/免責)→ Task 4 `buildSlackText` ✅
- 停損停利算法 → Task 3 `computeLevels` ✅
- 錯誤處理(單幣 fail-soft、Slack 失敗 log、整輪失敗不發警示)→ Task 2 `runScan` try/catch、Task 6 try/catch ✅
- 測試(scan/detect/slack/state 單元測試,stub fetch)→ Task 1/3/4/5 ✅
- 明確不做(不改 Worker、無多頻道/按鈕、不自動下單、無整輪失敗警示)→ 計畫未涉及 ✅

**Placeholder scan:** 無 TBD/TODO;每個 code step 均含完整程式碼與測試。

**Type consistency:** `ScanRow`(Task 1)欄位在 Task 2/3 一致;`Opportunity`(Task 3)在 Task 4/6 一致;`runScan/filterOpportunities/diffNewOpportunities/buildSlackText/postMessage/readActive/writeActive` 命名跨 Task 一致;`Direction` 字串值 `LONG/SHORT/NEUTRAL` 與 `effective` 的 `DOWNGRADED` 一致。

**Note:** Task 4 測試修改 `process.env`,依賴 Bun 對每檔獨立環境;若日後平行測試互擾,可改注入參數。此為已知取捨,現階段不做。
