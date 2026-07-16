// 紙上交易核心(純邏輯):把推播出去的機會轉成模擬部位、依後續 K 線判定停損/達標、
// 結算 R 值與損益,並彙整成績單。零相依,與回測共用同一套停損/達標假設。
import type { Opportunity } from "./detect.js";
import { suggestLeverage } from "./risk.js";

export interface PaperConfig {
  startEquity: number; // 起始權益(USDT)
  riskPct: number; // 每筆風險佔「開倉時權益」比例(2×ATR 停損 = 此金額)
  leverage: number; // 舊帳本部位的 fallback 槓桿(新部位改依 ATR 動態計算,見 risk.ts)
  feeRoundTrip: number; // 來回手續費佔名目比例(回測用 0.2%)
  intervalMs: number; // 訊號週期(4h)
}

export const defaultPaperConfig = (): PaperConfig => ({
  startEquity: 2000,
  riskPct: 0.01,
  leverage: 3,
  feeRoundTrip: 0.002,
  intervalMs: 4 * 3_600_000,
});

export type PaperStatus = "OPEN" | "STOP" | "TARGET";

export interface PaperPosition {
  key: string; // symbol:dir,與去重狀態一致
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  entryTime: number; // 進場毫秒(掃描時刻)
  entryBarOpen: number; // 進場那根 4h 棒的 openTime(判定時只看「之後」的棒,避免看未來)
  riskAmount: number; // 開倉時 equity×riskPct
  notional: number; // 名目部位
  qty: number; // 數量
  leverage?: number; // 開倉當下依 ATR 波動採用的槓桿(舊帳本無此欄位 → 讀取端視為 3x)
  marginUsed: number; // 佔用保證金 = notional/leverage
  liq: number; // 約略強平價(參考用)
  status: PaperStatus;
  exitPrice?: number;
  exitTime?: number;
  rMultiple?: number; // 已實現 R(停損≈-1、達標≈+1.5)
  pnl?: number; // 已實現損益(含手續費,USDT)
}

// 依「固定風險 1%」把一個機會定量成部位。停損距離決定名目大小。
export function sizePosition(
  o: Opportunity,
  equity: number,
  entryTime: number,
  cfg: PaperConfig,
): PaperPosition {
  const riskAmount = equity * cfg.riskPct;
  const stopDist = Math.abs(o.entry - o.stop);
  const stopFrac = stopDist / o.entry;
  const notional = riskAmount / stopFrac; // 命中停損恰好虧 riskAmount(未計手續費)
  const qty = notional / o.entry;
  // Opportunity 無 atr 欄位,但 detect 的停損固定是 2×ATR → 由停損距離精確反推。
  const leverage = suggestLeverage(stopDist / 2, o.entry);
  const marginUsed = notional / leverage;
  const liq = o.dir === "LONG" ? o.entry * (1 - 1 / leverage) : o.entry * (1 + 1 / leverage);
  const entryBarOpen = Math.floor(entryTime / cfg.intervalMs) * cfg.intervalMs;
  return {
    key: `${o.symbol}:${o.dir}`,
    symbol: o.symbol,
    dir: o.dir,
    entry: o.entry,
    stop: o.stop,
    target: o.target,
    entryTime,
    entryBarOpen,
    riskAmount,
    notional,
    qty,
    leverage,
    marginUsed,
    liq,
    status: "OPEN",
  };
}

// 把本輪新機會開成部位;已在場(同 key)者略過,避免重複開倉。
export function openPositions(
  opps: Opportunity[],
  openKeys: Set<string>,
  equity: number,
  entryTime: number,
  cfg: PaperConfig,
): PaperPosition[] {
  const out: PaperPosition[] = [];
  for (const o of opps) {
    const key = `${o.symbol}:${o.dir}`;
    if (openKeys.has(key)) continue;
    out.push(sizePosition(o, equity, entryTime, cfg));
  }
  return out;
}

export interface Bar {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

// 用進場之後(不含進場棒)的 K 線判定部位是否停損/達標。
// 同一根同時觸及停損與達標時,保守假設「先停損」。回傳結算後的部位(或原樣若仍持有)。
export function settlePosition(pos: PaperPosition, bars: Bar[], cfg: PaperConfig): PaperPosition {
  if (pos.status !== "OPEN") return pos;
  for (const b of bars) {
    if (b.openTime <= pos.entryBarOpen) continue; // 只看進場棒「之後」已收的棒
    const hitStop = pos.dir === "LONG" ? b.low <= pos.stop : b.high >= pos.stop;
    const hitTarget = pos.dir === "LONG" ? b.high >= pos.target : b.low <= pos.target;
    if (hitStop) return close(pos, pos.stop, "STOP", b.openTime, cfg);
    if (hitTarget) return close(pos, pos.target, "TARGET", b.openTime, cfg);
  }
  return pos;
}

function close(
  pos: PaperPosition,
  exitPrice: number,
  status: PaperStatus,
  exitTime: number,
  cfg: PaperConfig,
): PaperPosition {
  const sign = pos.dir === "LONG" ? 1 : -1;
  const stopDist = Math.abs(pos.entry - pos.stop);
  const rMultiple = ((exitPrice - pos.entry) * sign) / stopDist;
  const gross = pos.qty * (exitPrice - pos.entry) * sign;
  const fee = pos.notional * cfg.feeRoundTrip;
  return { ...pos, status, exitPrice, exitTime, rMultiple, pnl: gross - fee };
}

// 計算未結部位的浮動損益(以現價 mark)。
export function markToMarket(pos: PaperPosition, price: number, cfg: PaperConfig): number {
  const sign = pos.dir === "LONG" ? 1 : -1;
  const gross = pos.qty * (price - pos.entry) * sign;
  const fee = pos.notional * cfg.feeRoundTrip;
  return gross - fee;
}

export interface OpenMark {
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: number;
  price: number;
  unrealized: number; // 浮動損益(USDT)
}

// 組成績單(Slack 純文字)。opts 可帶策略標籤(標題)與基準註解(樣本足夠時顯示)。
export function buildScorecard(
  s: Summary,
  opens: OpenMark[],
  periodLabel: string,
  opts: { strategyLabel?: string; baseline?: string } = {},
): string {
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const pct = ((s.equity - s.startEquity) / s.startEquity) * 100;
  const pf = s.profitFactor === Number.POSITIVE_INFINITY ? "∞" : s.profitFactor.toFixed(2);
  const unreal = opens.reduce((a, o) => a + o.unrealized, 0);

  const title = opts.strategyLabel
    ? `📊 紙上交易成績單 · ${opts.strategyLabel} 策略 · ${periodLabel}`
    : `📊 紙上交易成績單 · ${periodLabel}`;
  const head =
    `${title}\n` +
    `權益 ${s.equity.toFixed(1)} / ${s.startEquity} USDT ` +
    `(${sign(pct)}${pct.toFixed(2)}%,已結 ${sign(s.realized)}${s.realized.toFixed(1)})`;

  const stats =
    `已結 ${s.closed} 筆｜勝率 ${(s.winRate * 100).toFixed(0)}% (${s.wins}勝${s.losses}敗)\n` +
    `平均 R ${sign(s.avgR)}${s.avgR.toFixed(2)}｜獲利因子 ${pf}｜最大連虧 ${s.maxConsecLoss} 筆\n` +
    `單筆最佳 ${sign(s.best)}${s.best.toFixed(1)}｜最差 ${s.worst.toFixed(1)} USDT`;

  const dirZh = (d: string) => (d === "SHORT" ? "空" : "多");
  const openBlock = opens.length
    ? `持倉中 ${opens.length} 筆:\n` +
      opens
        .map(
          (o) =>
            `  ${o.symbol} ${dirZh(o.dir)} 進${o.entry} 現${o.price} ` +
            `${sign(o.unrealized)}${o.unrealized.toFixed(1)}`,
        )
        .join("\n") +
      `\n  浮動合計 ${sign(unreal)}${unreal.toFixed(1)} USDT`
    : "持倉中:無";

  const note =
    s.closed < 20
      ? "⚠️ 樣本 <20 筆,勝率/PF 尚無統計意義,請持續累積。"
      : (opts.baseline ??
        "基準:回測 4h avgR ≈ +0.10;明顯低於此值才代表策略在當前市場失效。");

  return [head, "", stats, "", openBlock, "", note].join("\n");
}

export interface Summary {
  startEquity: number;
  realized: number; // 已結損益合計
  equity: number; // startEquity + realized
  closed: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1
  avgR: number; // 平均已實現 R
  profitFactor: number; // 毛利/毛損(無虧損時 Infinity)
  maxConsecLoss: number;
  open: number;
  best: number; // 單筆最佳 pnl
  worst: number; // 單筆最差 pnl
}

// 由部位帳彙整成績單(只統計已結部位;open 只計數)。
export function summarize(positions: PaperPosition[], cfg: PaperConfig): Summary {
  const closed = positions.filter((p) => p.status !== "OPEN");
  const open = positions.length - closed.length;
  const realized = closed.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const wins = closed.filter((p) => (p.pnl ?? 0) > 0);
  const losses = closed.filter((p) => (p.pnl ?? 0) <= 0);
  const grossWin = wins.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + (p.pnl ?? 0), 0));
  const avgR = closed.length
    ? closed.reduce((s, p) => s + (p.rMultiple ?? 0), 0) / closed.length
    : 0;

  // 最大連續虧損:依出場時間排序後掃描
  const byExit = [...closed].sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  let run = 0;
  let maxConsecLoss = 0;
  for (const p of byExit) {
    if ((p.pnl ?? 0) <= 0) {
      run++;
      maxConsecLoss = Math.max(maxConsecLoss, run);
    } else run = 0;
  }

  const pnls = closed.map((p) => p.pnl ?? 0);
  return {
    startEquity: cfg.startEquity,
    realized,
    equity: cfg.startEquity + realized,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgR,
    profitFactor:
      grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
    maxConsecLoss,
    open,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
  };
}
