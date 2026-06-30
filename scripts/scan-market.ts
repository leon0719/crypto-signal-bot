// 臨時掃描:用本專案訊號引擎跑主流幣 4h 訊號 + 1d 大週期確認 + OI 確認。
import { fetchKlines, fetchLastPrice } from "../src/bybit.js";
import { evalOiDir } from "../src/oi.js";
import { build, defaultConfig, evalAt, minBars } from "../src/signal.js";
import { Direction } from "../src/types.js";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "TONUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "NEARUSDT",
  "APTUSDT",
];
const INTERVAL = "4h";
const HTF = "1d";
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

for (const sym of SYMBOLS) {
  try {
    const klines = await fetchKlines("futures", sym, INTERVAL, 400);
    const ind = build(klines, cfg);
    const res = evalAt(ind, ind.klines.length - 2); // 最後一根已收盤 K 棒
    if (!res) {
      console.log(`${sym}\tDATA?`);
      continue;
    }
    const [htf, oi, live] = await Promise.all([
      htfScore(sym),
      evalOiDir(sym, INTERVAL, ind.klines),
      fetchLastPrice("futures", sym),
    ]);
    const htfConflict =
      htf != null &&
      ((res.direction === Direction.Long && htf < 0) ||
        (res.direction === Direction.Short && htf > 0));
    const oiConflict =
      oi != null &&
      ((res.direction === Direction.Long && oi < 0) ||
        (res.direction === Direction.Short && oi > 0));
    const eff =
      res.direction !== Direction.Neutral && (htfConflict || oiConflict)
        ? "觀望(降級)"
        : res.direction;
    console.log(
      [
        sym,
        eff,
        `score=${res.score.toFixed(1)}`,
        `4h=${res.regime}`,
        `adx=${res.adx.toFixed(0)}`,
        `htf1d=${htf?.toFixed(1) ?? "—"}`,
        `oi=${oi ?? "—"}`,
        `price=${live ?? res.price}`,
        `atr=${res.atr.toFixed(res.atr < 1 ? 5 : 2)}`,
        htfConflict ? "⚠HTF反向" : "",
        oiConflict ? "⚠OI反向" : "",
      ].join("\t"),
    );
  } catch (e) {
    console.log(`${sym}\tERR ${(e as Error).message}`);
  }
}
