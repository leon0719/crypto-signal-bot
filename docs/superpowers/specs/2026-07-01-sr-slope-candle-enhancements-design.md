# 策略增強：支撐壓力 / 均線斜率 / K 棒影線

日期：2026-07-01

## 背景

現有策略（`signal.ts`）以趨勢族（EMA 趨勢、EMA 快慢線交叉、MACD、OBV）加均值回歸族（RSI、Stochastic、Bollinger）加權評分，並用 ADX 自動切換兩族權重，另有成交量過濾、MTF 高週期確認、OI 確認降級。

參考多張技術分析教學圖後，挑出三個**低過擬合、可回測驗證**的補強項，排除圖形型態辨識（頭肩、雙頂雙底、旗形、楔形等）——後者辨識可靠度低、參數多、最易過擬合，違背既有回測教訓（`memory: ADX≥30 過擬合`）。

## 共同原則

- 三個模組都實作在 `signal.ts` 的 `evalAt` 內，只讀取**既有的指標陣列與 klines**，不需要額外的網路 fetch。因此三者**自動可被 `backtest.ts` 逐根驗證**。
- 每個模組掛在獨立的 `Config` 開關後，**預設關閉**，回測驗證通過才在 `defaultConfig` 打開。
- 只保留在 **train/test 分割的樣本外**能提升期望值、且**多數標的一致改善**的改動；單一標的變好視為僥倖。

## 模組 1｜支撐/壓力硬降級

沿用 MTF/OI 的「非對抗過濾 → 降觀望」機制（已驗證可泛化）。

- 用既有 `ta.swingPoints(high, low, srSpan)` 取轉折高低點。
- 最近壓力 = 現價上方最小的 swing high；最近支撐 = 現價下方最大的 swing low。
- 距離以 ATR 衡量，門檻 `srBufferATR`：
  - 做多訊號 且 `(nearestRes − price) ≤ srBufferATR × ATR` → 降 `Neutral`（觀望）。
  - 做空訊號 且 `(price − nearestSup) ≤ srBufferATR × ATR` → 降 `Neutral`。
- **Fail-soft**：找不到對應方向的 swing point 就跳過此過濾。
- `Result` 新增 `sr: { nearestRes: number; nearestSup: number; conflict: boolean }`（`conflict` 慣例與 `htf`/`oi` 一致），供 `format.ts` 卡片顯示。

**待回測參數**：`srSpan ≈ 5`、`srBufferATR ≈ 0.5`。

## 模組 2｜均線斜率降權（不硬砍）

對應教學圖「黃金交叉但長期均線下彎 → 不要買」，但改用連續量降權而非硬門檻，避免過擬合與反轉初期誤殺。

- `slopeSign = sign(emaLong[i] − emaLong[i − slopeLookback])`。
- 兩段式計算：
  1. 先以現有權重算出暫定分數與趨勢族淨方向。
  2. 若趨勢族淨方向與 `slopeSign` 相反，將趨勢族（趨勢、EMA 交叉、MACD、OBV）的權重乘上 `slopeDiscount` 後**重算分數**。
- 只降權、不降級。

**待回測參數**：`slopeLookback ≈ 5`、`slopeDiscount ≈ 0.5`。

## 模組 3｜K 棒影線拒絕（獨立加權項）

單根 K 棒的影線拒絕訊號，不做多根型態（吞沒、晨星等一律排除）。

- `upperShadow = high − max(open, close)`
- `lowerShadow = min(open, close) − low`
- `range = high − low`
- `val = clamp((lowerShadow − upperShadow) / range, −1, 1)`：長下影 → 偏多、長上影 → 偏空。
- 當作新的加權項，歸入均值回歸族（隨 ADX regime 調整），權重小。

**待回測參數**：影線權重 `≈ 0.5`。

## 驗證機制

1. 三個開關獨立加進 `backtest.ts` 的參數掃描。
2. 每個改動**單獨**跑 train/test 分割，比較樣本外期望值。
3. **多數標的（例如 8 標的中多數）一致改善**才採用。
4. 通過者才在 `defaultConfig` 預設打開，並比照 `takeATR` / `volumeMult` 的既有註解風格，寫下回測結論。

## 非目標（YAGNI）

- 圖形型態辨識（頭肩、M 頭、W 底、旗形、楔形、三角收斂等）。
- 多根 K 棒型態（吞沒、晨星、母子線等）。
- 任何需要額外網路 fetch 的資料來源。
