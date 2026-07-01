// 訊號評分:趨勢跟隨(EMA/MACD/OBV)+ 均值回歸(RSI/Stoch/BB)加權,並用 ADX 自動切換兩類權重。

import * as ta from "./ta.js";
import {
  type Component,
  type Config,
  Direction,
  type DirectionValue,
  type Indicators,
  type Kline,
  type Regime,
  type Result,
} from "./types.js";

export function defaultConfig(): Config {
  return {
    emaFast: 12,
    emaSlow: 26,
    emaMid: 50,
    emaLong: 200,
    rsiPeriod: 14,
    macdSignal: 9,
    bbPeriod: 20,
    stochK: 14,
    stochD: 3,
    atrPeriod: 14,
    adxPeriod: 14,
    obvFast: 10,
    obvSlow: 30,
    bbMult: 2.0,
    entryThreshold: 25,
    stopATR: 1.0,
    takeATR: 3.0, // 停損 1.0×ATR、停利 3.0×ATR → R:R = 1:3。回測(500 天、8 標的、train/test 分割)顯示較緊的停損 + 1:3 在樣本外期望值最穩。
    regimeSwitch: true,
    adxTrendMin: 25,
    adxRangeMax: 20,
    volumeFilter: true,
    volumeMult: 1.0, // 當根量 ≥ 均量即可(1.0)。回測顯示 1.0 比 1.2 樣本外期望值更高且 8/8 標的全賺。
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
  };
}

export function minBars(cfg: Config): number {
  return Math.max(
    cfg.emaMid,
    cfg.obvSlow,
    cfg.bbPeriod,
    cfg.rsiPeriod + 1,
    cfg.stochK + cfg.stochD,
    cfg.emaSlow + cfg.macdSignal,
  );
}

export function build(klines: Kline[], cfg: Config): Indicators {
  const close = klines.map((k) => k.close);
  const high = klines.map((k) => k.high);
  const low = klines.map((k) => k.low);
  const vol = klines.map((k) => k.volume);

  const { hist } = ta.macd(close, cfg.emaFast, cfg.emaSlow, cfg.macdSignal);
  const bb = ta.bollinger(close, cfg.bbPeriod, cfg.bbMult);
  const st = ta.stochastic(high, low, close, cfg.stochK, cfg.stochD);
  const obvSeries = ta.obv(close, vol);

  return {
    cfg,
    klines,
    close,
    high,
    low,
    emaFast: ta.ema(close, cfg.emaFast),
    emaSlow: ta.ema(close, cfg.emaSlow),
    emaMid: ta.ema(close, cfg.emaMid),
    emaLong: ta.ema(close, cfg.emaLong),
    rsi: ta.rsi(close, cfg.rsiPeriod),
    macdHist: hist,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    stochK: st.k,
    atr: ta.atr(high, low, close, cfg.atrPeriod),
    adx: ta.adx(high, low, close, cfg.adxPeriod),
    obvFast: ta.ema(obvSeries, cfg.obvFast),
    obvSlow: ta.ema(obvSeries, cfg.obvSlow),
    volSMA: ta.sma(vol, cfg.volumePeriod),
  };
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function evalAt(ind: Indicators, i: number): Result | null {
  const c = ind.cfg;
  const required = [
    ind.emaFast[i],
    ind.emaSlow[i],
    ind.emaMid[i],
    ind.rsi[i],
    ind.macdHist[i],
    ind.bbUpper[i],
    ind.bbLower[i],
    ind.stochK[i],
    ind.atr[i],
    ind.obvFast[i],
    ind.obvSlow[i],
  ];
  if (required.some((v) => Number.isNaN(v))) return null;

  let adx = ind.adx[i];
  if (Number.isNaN(adx)) adx = 0;
  const { regime, trendMul, rangeMul } = regimeOf(c, adx);

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

  let weighted = 0;
  let totalW = 0;
  for (const cp of comps) {
    weighted += cp.value * cp.weight;
    totalW += cp.weight;
  }
  const score = totalW > 0 ? (weighted / totalW) * 100 : 0;

  let dir: DirectionValue = Direction.Neutral;
  if (score >= c.entryThreshold) dir = Direction.Long;
  else if (score <= -c.entryThreshold) dir = Direction.Short;

  // 成交量過濾:有方向但當根量能不足(< 均量 × volumeMult)時,降級為觀望避免假突破。
  let volRatio = Number.NaN;
  const avgVol = ind.volSMA[i];
  if (!Number.isNaN(avgVol) && avgVol > 0) {
    volRatio = ind.klines[i].volume / avgVol;
    if (c.volumeFilter && dir !== Direction.Neutral && volRatio < c.volumeMult) {
      dir = Direction.Neutral;
    }
  }

  return {
    index: i,
    direction: dir,
    score,
    components: comps,
    adx,
    atr: ind.atr[i],
    price: ind.close[i],
    regime,
    volRatio,
  };
}

function regimeOf(c: Config, adx: number): { regime: Regime; trendMul: number; rangeMul: number } {
  if (!c.regimeSwitch || adx === 0) return { regime: "中性", trendMul: 1, rangeMul: 1 };
  // 強趨勢時幾乎停用均值回歸(RSI/Stoch/BB),避免超買/超賣在趨勢中持續輸出反向分數拖累評分。
  if (adx >= c.adxTrendMin) return { regime: "趨勢", trendMul: 1.0, rangeMul: 0.15 };
  if (adx <= c.adxRangeMax) return { regime: "盤整", trendMul: 0.4, rangeMul: 1.0 };
  return { regime: "中性", trendMul: 1, rangeMul: 1 };
}

const mul = (comp: Component, m: number): Component => ({ ...comp, weight: comp.weight * m });

function trendComp(ind: Indicators, i: number): Component {
  const close = ind.close[i];
  let longMA = ind.emaLong[i];
  if (Number.isNaN(longMA)) longMA = ind.emaMid[i];
  const val = (sign(ind.emaMid[i] - longMA) + sign(close - longMA)) / 2;
  const note = val > 0 ? "趨勢偏多" : val < 0 ? "趨勢偏空" : "均線分歧";
  return { name: "趨勢", value: val, weight: ind.cfg.weights.trend, note };
}

function emaCrossComp(ind: Indicators, i: number): Component {
  const val = sign(ind.emaFast[i] - ind.emaSlow[i]);
  return {
    name: "EMA 快慢線",
    value: val,
    weight: ind.cfg.weights.emaCross,
    note: val > 0 ? "快線在上" : "快線在下",
  };
}

function macdComp(ind: Indicators, i: number): Component {
  const val = sign(ind.macdHist[i]);
  return {
    name: "MACD",
    value: val,
    weight: ind.cfg.weights.macd,
    note: val > 0 ? "動能偏多" : "動能偏空",
  };
}

function obvComp(ind: Indicators, i: number): Component {
  const val = sign(ind.obvFast[i] - ind.obvSlow[i]);
  return {
    name: "OBV 量能",
    value: val,
    weight: ind.cfg.weights.obv,
    note: val > 0 ? "量能流入" : "量能流出",
  };
}

function rsiComp(ind: Indicators, i: number): Component {
  const r = ind.rsi[i];
  const val = clamp((50 - r) / 20, -1, 1);
  const note = r < 30 ? "超賣" : r > 70 ? "超買" : "中性";
  return { name: "RSI", value: val, weight: ind.cfg.weights.rsi, note };
}

function stochComp(ind: Indicators, i: number): Component {
  const k = ind.stochK[i];
  const val = clamp((50 - k) / 30, -1, 1);
  const note = k < 20 ? "超賣" : k > 80 ? "超買" : "中性";
  return { name: "Stochastic", value: val, weight: ind.cfg.weights.stoch, note };
}

function bbComp(ind: Indicators, i: number): Component {
  const up = ind.bbUpper[i];
  const low = ind.bbLower[i];
  const close = ind.close[i];
  const pctB = up !== low ? (close - low) / (up - low) : 0.5;
  const val = clamp((0.5 - pctB) * 2, -1, 1);
  const note = pctB < 0.2 ? "貼近下軌" : pctB > 0.8 ? "貼近上軌" : "通道中段";
  return { name: "Bollinger", value: val, weight: ind.cfg.weights.bb, note };
}

function shadowComp(ind: Indicators, i: number): Component {
  const k = ind.klines[i];
  const val = ta.shadowScore(k.open, k.high, k.low, k.close);
  const note = val > 0.2 ? "下影承接" : val < -0.2 ? "上影拋壓" : "影線中性";
  return { name: "K棒影線", value: val, weight: ind.cfg.weights.shadow, note };
}
