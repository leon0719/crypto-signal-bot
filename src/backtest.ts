// 回測:用歷史 K 線逐根重跑 evalAt,以 ATR 停損/停利模擬進出場,量化勝率與期望值。
//
// 設計重點(避免前視偏差 look-ahead bias):
//  - 訊號在第 i 根「收盤」才確定(evalAt 讀 close[i]),故進場價用「下一根 i+1 的開盤」。
//  - 停損/停利距離以「進場當下那根」的 ATR 計算,出場掃描只用「之後」的 high/low。
//  - 同一根同時觸及停損與停利時,保守假設「先觸停損」(悲觀估計,不高估勝率)。
//  - 一次只持一倉,平倉後才尋找下一個訊號(不重疊、不加碼)。

import { build, evalAt, minBars } from "./signal.js";
import {
  type Config,
  Direction,
  type DirectionValue,
  type Indicators,
  type Kline,
} from "./types.js";

export interface Trade {
  direction: DirectionValue;
  entryIndex: number; // 進場那根(= 訊號根 + 1)
  exitIndex: number; // 出場那根
  entryPrice: number;
  exitPrice: number;
  riskPrice: number; // 停損距離(價格單位),用來把手續費/滑點換算成 R
  rMultiple: number; // 以風險(stop 距離)為單位的盈虧;+2 代表賺 2 倍風險
  outcome: "win" | "loss";
  reason: "take" | "stop" | "eod"; // 觸發停利 / 停損 / 資料用盡強制平倉
}

export interface BacktestResult {
  trades: Trade[];
  total: number;
  wins: number;
  losses: number;
  winRate: number; // 0~1
  avgR: number; // 每筆平均 R(= 期望值,>0 才有正期望)
  totalR: number; // 累積 R
  profitFactor: number; // 總獲利 R / 總虧損 R;>1 才賺錢,Infinity = 無虧損
  maxDrawdownR: number; // R 權益曲線的最大回撤(正數,越小越好)
  avgWinR: number;
  avgLossR: number;
  avgBarsHeld: number; // 平均持倉根數
}

// 回測的進場訊號來源。回傳 Neutral 或 null 皆視為「本根無訊號」。
// 預設為 signal.ts 的 evalAt;換成 snr.ts 的 evalSnrAt 即可回測 SNR 策略,
// 出場與風險計算完全共用,確保 A/B 比較的唯一變因是進場。
export interface SignalHit {
  direction: DirectionValue;
  atr: number;
  price: number;
}
export type SignalFn = (ind: Indicators, i: number) => SignalHit | null;

export interface BacktestOptions {
  // 持倉中若出現「反向訊號」就平倉反手(預設 false,只靠停損/停利出場)。
  reverseOnSignal?: boolean;
  // 進場前的外部過濾:回傳 false 則略過該訊號(例:大週期 MTF 不同向)。
  // 參數為訊號方向與訊號所在的索引 i(進場為 i+1)。
  entryFilter?: (direction: DirectionValue, signalIndex: number) => boolean;
  // 出場模式:
  //  - "fixed"(預設):固定 takeATR 停利 + stopATR 停損。
  //  - "trailing":無固定停利,停損隨波段高/低點以 trailATR×ATR 移動(讓贏單跟趨勢)。
  exit?: "fixed" | "trailing";
  trailATR?: number; // trailing 模式的移動距離(×ATR),預設 2。
  // 進場訊號來源,省略時為 evalAt(現有評分策略)。
  signal?: SignalFn;
}

export function backtest(klines: Kline[], cfg: Config, opts: BacktestOptions = {}): BacktestResult {
  const ind = build(klines, cfg);
  const n = klines.length;
  const start = minBars(cfg); // 第一根可評估的索引
  const trades: Trade[] = [];
  const signal: SignalFn = opts.signal ?? evalAt;

  let i = start;
  while (i < n - 1) {
    const sig = signal(ind, i);
    if (!sig || sig.direction === Direction.Neutral) {
      i++;
      continue;
    }

    // 訊號於第 i 根收盤確定 → 用第 i+1 根開盤進場。
    const dir = sig.direction;

    // 外部過濾(如大週期確認):不通過則略過此訊號,往後再找。
    if (opts.entryFilter && !opts.entryFilter(dir, i)) {
      i++;
      continue;
    }

    const entryIndex = i + 1;
    const entryPrice = klines[entryIndex].open;
    const risk = cfg.stopATR * sig.atr;
    const reward = cfg.takeATR * sig.atr;
    const isLong = dir === Direction.Long;
    const stop = isLong ? entryPrice - risk : entryPrice + risk;
    const take = isLong ? entryPrice + reward : entryPrice - reward;

    const trade = simulateExit(
      klines,
      ind,
      entryIndex,
      dir,
      entryPrice,
      stop,
      take,
      risk,
      sig.atr,
      opts,
    );
    trades.push(trade);

    // 平倉後從出場那根之後再找下一個訊號(不重疊)。
    i = trade.exitIndex + 1;
  }

  return summarize(trades);
}

// 從進場那根(含)往後掃,回傳這筆交易的結果。
function simulateExit(
  klines: Kline[],
  ind: ReturnType<typeof build>,
  entryIndex: number,
  dir: DirectionValue,
  entryPrice: number,
  stop: number,
  take: number,
  risk: number,
  atr: number,
  opts: BacktestOptions,
): Trade {
  const n = klines.length;
  const isLong = dir === Direction.Long;
  const trailing = opts.exit === "trailing";
  const trailDist = (opts.trailATR ?? 2) * atr;
  // trailing:停損隨已收盤的波段高/低點移動;初始 = 固定停損。無固定停利。
  let trail = stop;
  let extreme = isLong ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;

  for (let j = entryIndex; j < n; j++) {
    const bar = klines[j];
    const activeStop = trailing ? trail : stop;
    const hitStop = isLong ? bar.low <= activeStop : bar.high >= activeStop;
    const hitTake = !trailing && (isLong ? bar.high >= take : bar.low <= take);

    // 同根同時觸及:保守假設先觸停損。
    if (hitStop) return close(j, activeStop, "stop");
    if (hitTake) return close(j, take, "take");

    // 反手出場:持倉中若收盤訊號轉為反向,於下一根開盤平倉。
    if (opts.reverseOnSignal && j > entryIndex && j < n - 1) {
      const s = (opts.signal ?? evalAt)(ind, j);
      const reversed =
        s &&
        ((isLong && s.direction === Direction.Short) ||
          (!isLong && s.direction === Direction.Long));
      if (reversed) return close(j + 1, klines[j + 1].open, "eod");
    }

    // 用「本根(已收盤)」的高/低更新移動停損,供下一根使用(不前視)。
    if (trailing) {
      extreme = isLong ? Math.max(extreme, bar.high) : Math.min(extreme, bar.low);
      const next = isLong ? extreme - trailDist : extreme + trailDist;
      trail = isLong ? Math.max(trail, next) : Math.min(trail, next);
    }
  }

  // 資料用盡:用最後一根收盤強制平倉。
  return close(n - 1, klines[n - 1].close, "eod");

  function close(exitIndex: number, exitPrice: number, reason: Trade["reason"]): Trade {
    const raw = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    const rMultiple = risk > 0 ? raw / risk : 0;
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
  }
}

export function summarize(trades: Trade[]): BacktestResult {
  const total = trades.length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = total - wins;

  let totalR = 0;
  let grossWin = 0;
  let grossLoss = 0; // 正數
  let barsHeld = 0;
  for (const t of trades) {
    totalR += t.rMultiple;
    if (t.rMultiple >= 0) grossWin += t.rMultiple;
    else grossLoss += -t.rMultiple;
    barsHeld += t.exitIndex - t.entryIndex;
  }

  // R 權益曲線的最大回撤(peak-to-trough)。
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    equity += t.rMultiple;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  return {
    trades,
    total,
    wins,
    losses,
    winRate: total > 0 ? wins / total : 0,
    avgR: total > 0 ? totalR / total : 0,
    totalR,
    profitFactor:
      grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownR,
    avgWinR: wins > 0 ? grossWin / wins : 0,
    avgLossR: losses > 0 ? grossLoss / losses : 0,
    avgBarsHeld: total > 0 ? barsHeld / total : 0,
  };
}

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
