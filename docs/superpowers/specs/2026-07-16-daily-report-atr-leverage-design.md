# 每日成績單 + ATR 動態槓桿 設計

日期:2026-07-16
狀態:已與使用者確認

## 目標

1. 紙上交易成績單從「每週一」改為「每天」推播一次(UTC0,台北 08:00)。
2. 依波動度(ATR)動態計算建議槓桿(1x–5x),套用到紙上交易記帳與 LINE 卡片顯示。

## 非目標

- 不改變每筆固定風險 1% 的資金管理(槓桿只影響保證金占用與理論強平價,不影響資金曲線)。
- Slack 掃描推播訊息不加建議槓桿(使用者選擇只套用紙上交易 + LINE 卡片)。
- 不做自動參數優化(見 memory:strategy-backtest-findings)。

## 核心規則:ATR% → 建議槓桿(階梯式)

`ATR%` = 4h ATR ÷ 現價 × 100。

| ATR% | 建議槓桿 |
|---|---|
| ≤ 1% | 5x |
| 1–1.5% | 4x |
| 1.5–2% | 3x |
| 2–3% | 2x |
| > 3% | 1x |

無效輸入(NaN、≤0 的 atr 或 price)一律回傳保守的 1x。

已討論並否決的替代方案:連續線性換算(邊界難解釋、輸出幾乎相同)、
由「強平距離 ≥ 3×停損距離」反推上限(絕大多數幣算出 5x,無區別度)。

## 改動點

### 1. `src/risk.ts`(新檔)

純函式 `suggestLeverage(atr: number, price: number): number`,回傳 1–5 整數。
邊界歸屬:門檻值本身屬於較低風險檔(atrPct === 1 → 5x、=== 1.5 → 4x,以此類推)。

### 2. `scripts/scheduler.ts` — 每日成績單

原「每週一 UTC0 那輪掃描後推成績單」改為「每天 UTC0 那輪」。其餘排程(每 4h 掃描)不變。

### 3. `src/paper.ts` — 動態槓桿記帳

- `PaperPosition` 新增 `leverage: number` 欄位(記錄開倉當下採用的槓桿)。
- 開倉(`openPositions`)改用 `suggestLeverage(atr, entry)` 取代固定 `cfg.leverage`;
  `marginUsed`、`liq` 按該值計算。
- **回溯相容**:既有帳本 JSON 的舊部位無 `leverage` 欄位,讀取時視為 3x
  (`p.leverage ?? 3`),不改寫舊資料。
- `PaperConfig.leverage`(固定 3)保留為 fallback 預設。

### 4. `src/format.ts` — LINE 卡片

- 期貨卡片一律新增一行:「⚡ 建議槓桿 Nx(ATR 波動 x.x%)」。
- 使用者指令自帶槓桿(如 `sol 4h 10x`)時,原本的槓桿試算列照舊保留,建議槓桿列並存。
- 現貨(spot)卡片不顯示。

## 資料流

```
signal.evalAt → atr, price
      ├─ scripts/detect.ts → paper-run.ts → openPositions(suggestLeverage) → 帳本
      └─ analyze.ts → format.ts buildFlexMessage(顯示建議槓桿列)
scheduler.ts(每天 UTC0)→ paper-report.ts → Slack 成績單
```

## 錯誤處理

- `suggestLeverage` 對無效輸入回 1x,永不 throw。
- 帳本舊部位缺 `leverage` → 預設 3x,結算邏輯不變(結算只看價格與停損/達標,與槓桿無關)。

## 測試

- `src/risk.test.ts`:五個分檔 + 邊界值(1、1.5、2、3)+ 無效輸入(NaN、0、負數)。
- `src/paper.test.ts`(擴充):開倉後 `leverage`、`marginUsed`、`liq` 符合 ATR 分檔;
  舊格式部位(無 leverage 欄位)結算不壞。
- `src/format.test.ts`(擴充):期貨卡片含「建議槓桿」列;spot 不含;帶 `10x` 指令時兩列並存。
- `scheduler` 的每日判斷若有既有測試則跟著改,無則以純函式抽出判斷邏輯並補測。
