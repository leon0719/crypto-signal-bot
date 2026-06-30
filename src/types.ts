// 全專案共用型別。

export interface Env {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
}

export type Market = "spot" | "futures";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const Direction = { Long: "LONG", Short: "SHORT", Neutral: "NEUTRAL" } as const;
export type DirectionValue = (typeof Direction)[keyof typeof Direction];

export interface Weights {
  trend: number;
  emaCross: number;
  macd: number;
  rsi: number;
  stoch: number;
  bb: number;
  obv: number;
}

export interface Config {
  emaFast: number;
  emaSlow: number;
  emaMid: number;
  emaLong: number;
  rsiPeriod: number;
  macdSignal: number;
  bbPeriod: number;
  stochK: number;
  stochD: number;
  atrPeriod: number;
  adxPeriod: number;
  obvFast: number;
  obvSlow: number;
  bbMult: number;
  entryThreshold: number;
  stopATR: number;
  takeATR: number;
  regimeSwitch: boolean;
  adxTrendMin: number;
  adxRangeMax: number;
  volumeFilter: boolean; // 量能不足時不出訊號
  volumeMult: number; // 當根量需 ≥ 均量 × 此倍數
  volumePeriod: number; // 均量計算根數
  weights: Weights;
}

export interface Indicators {
  cfg: Config;
  klines: Kline[];
  close: number[];
  emaFast: number[];
  emaSlow: number[];
  emaMid: number[];
  emaLong: number[];
  rsi: number[];
  macdHist: number[];
  bbUpper: number[];
  bbLower: number[];
  stochK: number[];
  atr: number[];
  adx: number[];
  obvFast: number[];
  obvSlow: number[];
  volSMA: number[];
}

export type Regime = "趨勢" | "盤整" | "中性";

export interface Component {
  name: string;
  value: number;
  weight: number;
  note: string;
}

export interface Result {
  index: number;
  direction: DirectionValue;
  score: number;
  components: Component[];
  adx: number;
  atr: number;
  price: number;
  regime: Regime;
  volRatio: number; // 當根量 / 均量;NaN 表示未計算
}

// 解析後的指令。
export interface HelpCommand {
  help: true;
}
export interface AnalyzeCommand {
  help: false;
  symbol: string;
  interval: string;
  market: Market;
  leverage: number;
}
export type Command = HelpCommand | AnalyzeCommand;

// 大週期確認結果。
export interface HtfInfo {
  interval: string;
  score: number;
  conflict: boolean;
}

// LINE 訊息(只用到 text / flex)。
export type Flex = Record<string, unknown>;
export interface QuickReplyItem {
  type: "action";
  action: { type: "message"; label: string; text: string };
}
export interface QuickReply {
  items: QuickReplyItem[];
}
export type LineMessage = (
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Flex }
) & { quickReply?: QuickReply };
