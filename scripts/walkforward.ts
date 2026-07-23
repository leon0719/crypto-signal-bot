#!/usr/bin/env bun
// 走動前推(walk-forward):參數固定不動,逐季度評估策略在「沒被調校過的期間」的表現。
//
// 為什麼需要這支:docs/strategy-backtest.md 的所有結論都落在同一段 ~16 個月、單一
// 市場 régime。Bybit 4h 有 2021-01 至今、涵蓋 2021 頂部/2022 熊市/2023 復甦/2024-25
// 多頭的資料。若邊際優勢只存在於近期,那就是對某段行情的過擬合;若跨四種市況都成立,
// 才算「撐過了沒有為它量身訂做的環境」。
//
// 這是走動前推「評估」不是「優化」——參數一律用 defaultConfig(),不逐窗重新擬合。
// 要回答的是「目前這組設定穩不穩」,不是「每段期間最好的參數是什麼」。
//
// 用法:bun run walkforward [interval]  (預設 4h)
// 首次執行會抓數年 K 線並寫入 ./.cache/klines,需數分鐘。

import { backtest, netR, type Trade } from "../src/backtest.js";
import {
  barMs,
  calendarQuarters,
  HTF_MAP,
  htfEntryFilter,
  loadKlines,
  type Window,
} from "../src/backtest-harness.js";
import { SYMBOLS } from "../src/scan.js";
import { defaultConfig } from "../src/signal.js";
import type { Kline } from "../src/types.js";

const BARS_4H = 12000; // ~5.5 年
const EQUITY = 2000;
const RISK = 0.01; // 每筆風險 1%,把 R 換成 USDT 用

interface Loaded {
  symbol: string;
  k: Kline[];
  htf: Kline[];
}

interface QuarterStat {
  label: string;
  n: number;
  wins: number;
  netR: number;
  longs: number;
  shorts: number;
  symbols: number; // 該季有資料的標的數
  btcPct: number | null; // BTC 該季漲跌,當市況標籤
}

function pctChange(k: Kline[], w: Window): number | null {
  const inWin = k.filter((b) => b.openTime >= w.from && b.openTime < w.to);
  if (inWin.length < 2) return null;
  return ((inWin[inWin.length - 1].close - inWin[0].open) / inWin[0].open) * 100;
}

async function main(): Promise<void> {
  const [interval = "4h"] = process.argv.slice(2);
  const cfg = defaultConfig();
  const htfInterval = HTF_MAP[interval];
  const bars = interval === "4h" ? BARS_4H : 12000;
  const htfBars = htfInterval ? Math.ceil((bars * barMs(interval)) / barMs(htfInterval)) + 300 : 0;

  console.log(
    `走動前推:${interval}、參數固定為 defaultConfig(stop${cfg.stopATR}/take${cfg.takeATR})、` +
      `MTF ${htfInterval ?? "無"}、含 0.2% 成本`,
  );
  console.log(`載入歷史(每標的最多 ${bars} 根,首次會很久)…`);

  const loaded: Loaded[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const k = await loadKlines(symbol, interval, bars);
      if (k.length < 500) {
        console.log(`  ${symbol} 僅 ${k.length} 根,歷史太短,排除`);
        continue;
      }
      const htf = htfInterval ? await loadKlines(symbol, htfInterval, htfBars) : [];
      loaded.push({ symbol, k, htf });
    } catch (e) {
      console.log(`  ${symbol} 失敗,略過:${e instanceof Error ? e.message : e}`);
    }
  }
  if (loaded.length === 0) throw new Error("沒有可用標的");

  const btc = loaded.find((l) => l.symbol === "BTCUSDT");
  const first = Math.min(...loaded.map((l) => l.k[0].openTime));
  const last = Math.max(...loaded.map((l) => l.k[l.k.length - 1].openTime));
  const windows = calendarQuarters(first, last);

  console.log(
    `\n標的 ${loaded.length} 個、資料 ${new Date(first).toISOString().slice(0, 10)} ~ ` +
      `${new Date(last).toISOString().slice(0, 10)}、共 ${windows.length} 季\n`,
  );

  // 每個標的的 MTF 過濾器建一次即可(與窗無關,省下重複建指標的成本)。
  const filters = new Map(
    loaded.map((l) => [
      l.symbol,
      htfEntryFilter(l.k, l.htf.length ? l.htf : undefined, interval, htfInterval, cfg),
    ]),
  );

  const stats: QuarterStat[] = [];
  for (const w of windows) {
    const all: Trade[] = [];
    let symbols = 0;
    for (const l of loaded) {
      // 該標的在這一季有沒有資料(上市時間不同)
      if (!l.k.some((b) => b.openTime >= w.from && b.openTime < w.to)) continue;
      symbols++;
      const mtf = filters.get(l.symbol);
      const r = backtest(l.k, cfg, {
        entryFilter: (dir, i) => {
          const closeAt = l.k[i].openTime + barMs(interval); // 訊號於此棒收盤確定
          if (closeAt < w.from || closeAt >= w.to) return false;
          return mtf ? mtf(dir, i) : true;
        },
      });
      all.push(...r.trades);
    }
    if (all.length === 0) continue;
    stats.push({
      label: w.label,
      n: all.length,
      wins: all.filter((t) => netR(t) > 0).length,
      netR: all.reduce((s, t) => s + netR(t), 0),
      longs: all.filter((t) => t.direction === "LONG").length,
      shorts: all.filter((t) => t.direction === "SHORT").length,
      symbols,
      btcPct: btc ? pctChange(btc.k, w) : null,
    });
  }

  console.log("季度    幣數   筆數  勝率   淨avgR   累積R      USDT   多/空      BTC");
  console.log("─".repeat(76));
  for (const s of stats) {
    const avg = s.netR / s.n;
    const usdt = s.netR * EQUITY * RISK;
    console.log(
      `${s.label}  ${String(s.symbols).padStart(4)}  ${String(s.n).padStart(5)}  ` +
        `${((s.wins / s.n) * 100).toFixed(0).padStart(3)}%  ` +
        `${avg >= 0 ? "+" : ""}${avg.toFixed(3).padStart(6)}  ` +
        `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1).padStart(6)}  ` +
        `${usdt >= 0 ? "+" : ""}${usdt.toFixed(0).padStart(6)}  ` +
        `${String(s.longs).padStart(3)}/${String(s.shorts).padEnd(4)}  ` +
        `${s.btcPct == null ? "   —" : `${s.btcPct >= 0 ? "+" : ""}${s.btcPct.toFixed(0)}%`}`,
    );
  }

  const n = stats.reduce((a, s) => a + s.n, 0);
  const totalR = stats.reduce((a, s) => a + s.netR, 0);
  const up = stats.filter((s) => s.netR > 0).length;
  const bear = stats.filter((s) => (s.btcPct ?? 0) < 0);
  const bull = stats.filter((s) => (s.btcPct ?? 0) >= 0);
  const agg = (xs: QuarterStat[]) => {
    const nn = xs.reduce((a, s) => a + s.n, 0);
    const rr = xs.reduce((a, s) => a + s.netR, 0);
    return nn ? `n=${nn} 淨avgR=${(rr / nn).toFixed(3)} 累積=${rr.toFixed(1)}R` : "無樣本";
  };

  console.log("─".repeat(76));
  console.log(
    `合計 ${stats.length} 季、n=${n}、淨avgR=${(totalR / n).toFixed(3)}、累積=${totalR.toFixed(1)}R`,
  );
  console.log(`賺錢季度 ${up}/${stats.length}(${((up / stats.length) * 100).toFixed(0)}%)`);
  console.log(`  BTC 上漲季(${bull.length} 季):${agg(bull)}`);
  console.log(`  BTC 下跌季(${bear.length} 季):${agg(bear)}`);
  console.log(
    "\n判讀:參數未經任何一季調校。若只有近幾季為正 → 對近期行情過擬合;" +
      "若跨多頭/空頭季度皆為正 → 邊際優勢來自策略結構。\n" +
      "注意:此處為逐筆獨立計算,未套用 detect.ts 的相關性護欄,亦未模擬同時持倉的資金占用。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
