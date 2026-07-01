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
  shadow: number; // K 棒影線加權項
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
  // 支撐/壓力硬降級:貼近反向水平價位時把訊號降為觀望。
  srFilter: boolean;
  srSpan: number; // 轉折高低點左右確認根數
  srBufferATR: number; // 「貼近」門檻(×ATR)
  // 均線斜率降權:趨勢族淨方向與長期均線斜率相反時,趨勢族權重打折(非降級)。
  slopeFilter: boolean;
  slopeLookback: number; // 量 emaLong 斜率的回看根數
  slopeDiscount: number; // 逆斜率時趨勢族權重乘數(0~1)
  shadowComp: boolean; // 啟用 K 棒影線加權項
  weights: Weights;
}

export interface Indicators {
  cfg: Config;
  klines: Kline[];
  close: number[];
  high: number[];
  low: number[];
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

// 最近支撐/壓力與是否牴觸(conflict = 訊號往反向水平價位撞牆)。
export interface SrInfo {
  nearestRes: number;
  nearestSup: number;
  conflict: boolean;
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
  sr?: SrInfo; // 支撐/壓力感知(srFilter 關閉時為 undefined)
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

// OI(未平倉量)趨勢確認結果。dir: -1/0/1;conflict = OI 明確與訊號方向相反(「不反對」過濾)。
export interface OiInfo {
  dir: number;
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
