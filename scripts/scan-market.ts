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
