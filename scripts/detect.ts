// 定時偵測進入點:bun scripts/detect.ts [策略名](預設 4h)。
// 掃描 → 篩有效機會 → 與上輪去重 →(依策略設定)推新機會到 Slack → 紙上交易記帳。
import { fetchKlines, fetchLastPrice } from "../src/bybit.js";
import {
  diffNewOpportunities,
  filterOpportunities,
  guardOpportunities,
  keyOf,
} from "../src/detect.js";
import { executeLive, liveConfigFromEnv } from "../src/live.js";
import { credsFromEnv } from "../src/okx.js";
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
  const { news: rawNews, active } = diffNewOpportunities(opps, prev);

  // 相關性護欄:同輪同方向 ≥3 只留最強、同方向持倉上限 3(以紙上帳本的未結部位計,
  // 本輪結算前的保守計數)。被擋的 key 仍寫入 active——整批降級,不讓其餘幾支下輪補進。
  const ledger = await readLedger(PAPER_PATH, PAPER_START);
  const openByDir = { LONG: 0, SHORT: 0 };
  for (const p of ledger.positions) if (p.status === "OPEN") openByDir[p.dir]++;
  const { kept: news, notes: guardNotes } = guardOpportunities(rawNews, openByDir);
  if (guardNotes.length > 0) console.log(`${tag} [護欄] ${guardNotes.join(";")}`);

  console.log(
    `${tag} [${new Date().toISOString()}] 掃描完成:有效機會 ${opps.length}、新機會 ${rawNews.length}、護欄後 ${news.length}`,
  );

  // 預設把本輪全部有效機會寫入狀態;若推播失敗,把新機會的 key 撤回,下輪可補推。
  let committed = active;
  if (strategy.pushSignals && news.length > 0) {
    try {
      const guardLine = guardNotes.length > 0 ? `\n⚠️ 護欄:${guardNotes.join(";")}` : "";
      await postMessage(buildSlackText(news) + guardLine);
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
        // 2026-07-23:移除 exit: "trailing" 覆寫,回到 defaultPaperConfig 的 "fixed"。
        // 先前改 trailing 的依據(docs §3)是在「停損 2×ATR」的錯誤假設下量的;
        // 修正停損倍數後重測,fixed(stop1/take3)淨avgR +0.146 明顯優於 trailing 的 −0.014。
      };
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

  // 實盤下單:只有 liveTrading 策略;開關/護欄/dry-run 都在 executeLive 內處理。
  // 任何錯誤不影響訊號推播與紙上記帳(executeLive 內部已逐筆告警,這裡是最後防線)。
  if (strategy.liveTrading) {
    if (
      !process.env.OKX_API_KEY ||
      !process.env.OKX_API_SECRET ||
      !process.env.OKX_API_PASSPHRASE
    ) {
      // 未設定 OKX,實盤停用(靜默;避免每輪都噴錯誤 log)
    } else {
      try {
        const cfg = liveConfigFromEnv(intervalMsOf(strategy.interval));
        const controlChannel = process.env.SLACK_CONTROL_CHANNEL_ID;
        const res = await executeLive(news, cfg, {
          creds: credsFromEnv(),
          notify: (text) => postMessage(text, controlChannel),
          lastPrice: (sym) => fetchLastPrice("futures", sym),
          now: () => Date.now(),
        });
        console.log(
          `${tag} [實盤] 開倉 ${res.opened} 筆${res.skipped.length ? `、跳過:${res.skipped.join(";")}` : ""}`,
        );
      } catch (e) {
        console.error(`${tag} [實盤] 執行失敗:${(e as Error).message}`);
      }
    }
  }
}
