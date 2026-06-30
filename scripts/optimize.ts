#!/usr/bin/env bun
// 策略參數優化:深抓歷史(history-candles,可達 ~500 天 1h),用 train/test 分割
// 與「跨標的穩健度」分階段網格搜尋,挑出不易過擬合的設定。
//
// 用法:
//   bun run optimize            # 1h,一籃子幣
//   bun run optimize 4h         # 指定週期
//
// 設計重點:
//  - 樣本切成「前 70% 訓練 / 後 30% 測試」。在訓練集挑參數,看測試集是否仍成立。
//  - 不只看彙總,還看「各標的 PF 的最小值」與「PF>1 的標的比例」——
//    單一幣靠運氣賺錢不算數,要多數標的都站得住才採用。
//  - 分階段搜尋(R:R → 門檻 → 過濾器)而非完整笛卡兒積,降低過擬合與執行時間。
//  - 抓到的 K 線快取到 scratchpad,反覆執行不重抓。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backtest, summarize, type Trade } from "../src/backtest.js";
import { build, defaultConfig, evalAt, minBars } from "../src/signal.js";
import { type Config, Direction, type DirectionValue, type Kline } from "../src/types.js";

// 各週期對應的大週期確認(與 src/analyze.ts 的 HTF_MAP 一致)。
const HTF_MAP: Record<string, string> = {
  "15m": "1h",
  "30m": "2h",
  "1h": "4h",
  "2h": "12h",
  "4h": "1d",
  "1d": "1w",
};

function barMs(interval: string): number {
  const n = Number(interval.slice(0, -1));
  const unit = interval.slice(-1);
  const u: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * (u[unit] ?? 3_600_000);
}

// 把大週期評分嚴格對齊到 base 索引(只引用「在 base 收盤前已收盤」的大週期 K 棒,無前視)。
// 回傳 entryFilter:大週期反向則略過(非衝突過濾,與卡片的「降級觀望」邏輯一致)。
function htfEntryFilter(
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
const HISTORY_URL = "https://www.okx.com/api/v5/market/history-candles";
const CACHE_DIR =
  "/private/tmp/claude-501/-Users-riversoft-Desktop-workSpace-side-project-crypto-signal-bot/568f0caa-1339-45bf-915a-fb4dc5d76504/scratchpad/klines";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function instId(symbol: string): string {
  return `${symbol.replace(/USDT$/, "")}-USDT-SWAP`;
}
function okxBar(interval: string): string {
  const unit = interval[interval.length - 1];
  return unit === "m" ? interval : interval.toUpperCase();
}

// 深抓歷史:用 after 往回翻頁(由新到舊),節流避免 50011。回傳由舊到新。
async function fetchDeep(symbol: string, interval: string, maxBars: number): Promise<Kline[]> {
  const inst = instId(symbol);
  const bar = okxBar(interval);
  const rows: string[][] = [];
  let after: string | undefined;
  while (rows.length < maxBars) {
    let u = `${HISTORY_URL}?instId=${inst}&bar=${bar}&limit=100`;
    if (after) u += `&after=${after}`;
    const res = await fetch(u);
    const body = (await res.json()) as { code: string; msg: string; data: string[][] };
    if (body.code !== "0") {
      if (body.code === "50011") {
        await sleep(500);
        continue;
      }
      throw new Error(`OKX ${body.code}: ${body.msg}`);
    }
    if (!body.data.length) break;
    rows.push(...body.data);
    after = body.data[body.data.length - 1][0];
    await sleep(120);
  }
  return rows
    .map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    .sort((a, b) => a.openTime - b.openTime);
}

async function loadKlines(symbol: string, interval: string, maxBars: number): Promise<Kline[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = `${CACHE_DIR}/${symbol}-${interval}-${maxBars}.json`;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Kline[];
  } catch {
    process.stdout.write(`  抓 ${symbol} ${interval}…`);
    const k = await fetchDeep(symbol, interval, maxBars);
    writeFileSync(path, JSON.stringify(k));
    console.log(` ${k.length} 根`);
    return k;
  }
}

interface Agg {
  total: number;
  winRate: number;
  avgR: number;
  totalR: number;
  pf: number;
  minSymbolPF: number; // 各標的 PF 的最小值(穩健度)
  symbolsProfitable: number; // PF>1 的標的數
  symbolCount: number;
}

interface Dataset {
  symbol: string;
  klines: Kline[];
  htf?: Kline[]; // 對齊用的大週期(完整序列)
}

interface EvalOpts {
  mtf: boolean; // 是否套用大週期確認過濾
  baseInterval: string;
  htfInterval?: string;
}

// 對一組資料(每個標的的某段 K 線)跑回測並彙總,附上跨標的穩健度。
function evalConfig(data: Dataset[], cfg: Config, opts: EvalOpts): Agg {
  const all: Trade[] = [];
  let minPF = Number.POSITIVE_INFINITY;
  let profitable = 0;
  for (const d of data) {
    const filter = opts.mtf
      ? htfEntryFilter(d.klines, d.htf, opts.baseInterval, opts.htfInterval, cfg)
      : undefined;
    const r = backtest(d.klines, cfg, { entryFilter: filter });
    all.push(...r.trades);
    const pf = r.profitFactor;
    if (r.total >= 5) {
      if (pf < minPF) minPF = pf;
      if (pf > 1) profitable++;
    }
  }
  const s = summarize(all);
  return {
    total: s.total,
    winRate: s.winRate,
    avgR: s.avgR,
    totalR: s.totalR,
    pf: s.profitFactor,
    minSymbolPF: minPF === Number.POSITIVE_INFINITY ? 0 : minPF,
    symbolsProfitable: profitable,
    symbolCount: data.length,
  };
}

function fmt(a: Agg): string {
  const pf = a.pf === Infinity ? "∞" : a.pf.toFixed(2);
  const mpf = a.minSymbolPF === Infinity ? "∞" : a.minSymbolPF.toFixed(2);
  return (
    `n=${String(a.total).padStart(4)} ` +
    `勝${(a.winRate * 100).toFixed(0).padStart(2)}% ` +
    `avgR=${a.avgR.toFixed(3).padStart(6)} ` +
    `累計=${a.totalR.toFixed(0).padStart(4)}R ` +
    `PF=${pf.padStart(4)} ` +
    `minPF=${mpf.padStart(4)} ` +
    `賺錢標的=${a.symbolsProfitable}/${a.symbolCount}`
  );
}

function split(klines: Kline[]): { train: Kline[]; test: Kline[] } {
  const cut = Math.floor(klines.length * 0.7);
  return { train: klines.slice(0, cut), test: klines.slice(cut) };
}

async function main(): Promise<void> {
  const [interval = "1h"] = process.argv.slice(2);
  const maxBars = interval.endsWith("m") ? 8000 : interval === "1h" ? 12000 : 3000;
  const htfInterval = HTF_MAP[interval];
  // 大週期所需根數:覆蓋 base 期間 + 暖機。
  const htfMaxBars = htfInterval
    ? Math.ceil((maxBars * barMs(interval)) / barMs(htfInterval)) + 300
    : 0;

  console.log(`載入歷史(${interval}, 每標的最多 ${maxBars} 根;大週期確認=${htfInterval ?? "無"})…`);
  const full: Dataset[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const klines = await loadKlines(symbol, interval, maxBars);
      if (klines.length <= 500) continue;
      const htf = htfInterval ? await loadKlines(symbol, htfInterval, htfMaxBars) : undefined;
      full.push({ symbol, klines, htf });
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  const first = full[0]?.klines;
  const span = first
    ? `${new Date(first[0].openTime).toISOString().slice(0, 10)} ~ ${new Date(first[first.length - 1].openTime).toISOString().slice(0, 10)}`
    : "";
  console.log(`標的 ${full.length} 個,${full[0]?.klines.length ?? 0} 根/個,期間 ${span}\n`);

  // train/test 切的是 base K 線;htf 保留完整序列(對齊靠時間戳,切片不影響正確性)。
  const train: Dataset[] = full.map((d) => ({ ...d, klines: split(d.klines).train }));
  const test: Dataset[] = full.map((d) => ({ ...d, klines: split(d.klines).test }));
  const optBase: EvalOpts = { mtf: true, baseInterval: interval, htfInterval };

  // 在訓練集評估、測試集驗證的小工具(預設已套用 MTF 過濾)。
  const show = (label: string, cfg: Config) => {
    console.log(`${label}`);
    console.log(`    train ${fmt(evalConfig(train, cfg, optBase))}`);
    console.log(`    test  ${fmt(evalConfig(test, cfg, optBase))}`);
  };

  // 穩健度評分:以「測試集(樣本外)」為主,要求訓練集也為正(否則視為雜訊),
  // 再獎勵跨標的一致性。這才是我們真正想最大化的目標——不是 train 數字最漂亮。
  const robustScore = (cfg: Config): number => {
    const tr = evalConfig(train, cfg, optBase);
    const te = evalConfig(test, cfg, optBase);
    if (tr.avgR <= 0 || te.total < 50) return -Infinity;
    return te.avgR * 100 + te.minSymbolPF * 5 + te.symbolsProfitable;
  };

  const base = defaultConfig();
  if (htfInterval) {
    // 先量化 MTF 過濾本身的價值:同一參數,關閉 vs 開啟大週期確認。
    console.log("【MTF 過濾價值對照(defaultConfig)】");
    const off: EvalOpts = { ...optBase, mtf: false };
    console.log(`  MTF off  test ${fmt(evalConfig(test, base, off))}`);
    console.log(`  MTF on   test ${fmt(evalConfig(test, base, optBase))}`);
  }
  console.log("\n【基準 defaultConfig(已含 MTF)】");
  show("  baseline", base);

  // ── 階段 A:R:R(停損/停利距離)──────────────────────────
  console.log("\n【階段 A:R:R(stopATR / takeATR)】");
  const rrGrid: [number, number][] = [
    [1.0, 2.0],
    [1.5, 2.25],
    [1.5, 3.0],
    [1.5, 4.5],
    [2.0, 3.0],
    [2.0, 4.0],
    [2.5, 5.0],
    [1.0, 3.0],
  ];
  let bestRR = { stopATR: base.stopATR, takeATR: base.takeATR };
  let bestRRScore = -Infinity;
  for (const [s, t] of rrGrid) {
    const cfg = { ...base, stopATR: s, takeATR: t };
    show(`  stop=${s} take=${t} (R:R=1:${(t / s).toFixed(1)})`, cfg);
    const score = robustScore(cfg);
    if (score > bestRRScore) {
      bestRRScore = score;
      bestRR = { stopATR: s, takeATR: t };
    }
  }
  console.log(`  → 階段 A 選 stop=${bestRR.stopATR} take=${bestRR.takeATR}`);

  // ── 階段 B:進場門檻 ───────────────────────────────────
  console.log("\n【階段 B:entryThreshold】");
  const afterA = { ...base, ...bestRR };
  let bestTh = base.entryThreshold;
  let bestThScore = -Infinity;
  for (const th of [18, 22, 25, 28, 32, 36, 40]) {
    const cfg = { ...afterA, entryThreshold: th };
    show(`  th=${th}`, cfg);
    const score = robustScore(cfg);
    if (score > bestThScore) {
      bestThScore = score;
      bestTh = th;
    }
  }
  console.log(`  → 階段 B 選 th=${bestTh}`);

  // ── 階段 C:量能過濾 + regime 切換 ───────────────────────
  console.log("\n【階段 C:量能過濾 / regime】");
  const afterB = { ...afterA, entryThreshold: bestTh };
  const variants: { label: string; patch: Partial<Config> }[] = [
    { label: "量能 off", patch: { volumeFilter: false } },
    { label: "量能 1.0", patch: { volumeFilter: true, volumeMult: 1.0 } },
    { label: "量能 1.2", patch: { volumeFilter: true, volumeMult: 1.2 } },
    { label: "量能 1.5", patch: { volumeFilter: true, volumeMult: 1.5 } },
    { label: "regime off", patch: { regimeSwitch: false } },
    { label: "regime 嚴(trend30/range15)", patch: { adxTrendMin: 30, adxRangeMax: 15 } },
  ];
  for (const v of variants) {
    show(`  ${v.label}`, { ...afterB, ...v.patch });
  }

  console.log("\n=== 收斂建議 ===");
  console.log(`A) stopATR=${bestRR.stopATR} takeATR=${bestRR.takeATR}`);
  console.log(`B) entryThreshold=${bestTh}`);
  console.log("C) 依上表挑「test 集 avgR>0 且 minPF 不破 1、賺錢標的多數」者");
  console.log("\n判讀:train 強而 test 崩 = 過擬合,別採用。要的是 train/test 都穩、跨標的一致。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
