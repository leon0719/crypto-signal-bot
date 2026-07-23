# SNR(支撐壓力)策略回測設計

日期:2026-07-23

## 目標

用回測判斷「支撐壓力(SNR)交易」是否值得成為獨立進場策略,而不是先憑感覺選一種
規則再花數月紙上交易才發現不行。本次**只做離線評估**,不改 production 訊號、不新增
並行策略、不接實盤。

## 背景

支撐壓力在專案裡已經存在,但只當**過濾器**:

- `ta.swingPoints()` / `ta.nearestSR()`:fractal 轉折高低點,`srSpan: 5`,lookback 200。
  只採計「右側已收滿 span 根」的轉折點,無前視偏差。
- `signal.ts` 的 `srFilter`:訊號方向若貼近反向水平位(距離 ≤ `srBufferATR × ATR`,
  預設 0.5)就硬降級為觀望。回測記錄:開啟後 4h avgR 0.001 → 0.166、賺錢標的 4→7/8。

`srFilter` 的結果本身是個線索:在該批資料上,**價格接近水平位時傾向被擋下而非穿過**。
這偏向支持反轉型(A),不利於裸突破型(B)。但那是「不進場」的證據,不等於
「反向進場會賺」——兩者之間隔著手續費與滑點。所以要實測。

## 規則定義

水平位來源兩組共用 `ta.nearestSR()`,不另造輪子。

### A 反轉型

- 做多:價格跌至最近支撐的 `touchATR × ATR`(初值 0.3)範圍內,且該根**收盤仍在支撐之上**
- 做空:價格觸及最近壓力的同等範圍內,且該根**收盤仍在壓力之下**

### B 突破型

- 做多:收盤**站上**最近壓力,超出 `breakATR × ATR`(初值 0.3)
- 做空:收盤**跌破**最近支撐,超出同等距離

兩組都不看評分、不看 EMA/RSI/MACD——這是重點,要測的是水平位本身有沒有邊際優勢。

### 刻意固定的變因

**出場與現有策略完全相同**:1×ATR 初始停損 + 2×ATR 移動停損(`exit: "trailing"`)。

SNR 交易的正統做法是把停損放在水平位外側(結構性停損),但若進場與出場同時更換,
測出的差異無法歸因。先固定出場、只換進場;確認進場邊際存在後,再單獨測結構性停損。

**第一輪只跑最單純的 A 與 B**。影線拒絕確認(`ta.shadowScore` 已存在)、突破回踩確認、
結構性停損一律不做。變體愈多,事後挑到「看起來最好的組合」的機率愈高——
`docs/strategy-backtest.md` 記錄的 ADX≥30 過擬合就是這麼來的。單純版本沒有訊號就收手。

## 程式結構

### 新檔 `src/snr.ts`

```ts
export type SnrMode = "reversal" | "breakout";
export function evalSnrAt(ind: Indicators, i: number, cfg: SnrConfig, mode: SnrMode)
  : { direction: DirectionValue; atr: number; price: number } | null
```

純函式,讀 `signal.build()` 產出的 `Indicators`(high/low/close/atr 皆在其中),零相依。
與 `signal.ts` 平行的地位。任何必需值為 `NaN` 時回傳 `null`(與 `evalAt` 的慣例一致)。

`SnrConfig` 僅含 `srSpan`、`touchATR`、`breakATR`,不重用肥大的 `Config`。

### `src/backtest.ts`:進場訊號 hook

目前 `backtest()` 寫死呼叫 `evalAt`。新增:

```ts
interface BacktestOptions {
  signal?: (ind: Indicators, i: number) => { direction; atr; price } | null;  // 預設 evalAt
}
```

`reverseOnSignal` 的反手偵測走同一個 hook。現有呼叫端無須修改。

### `src/backtest.ts`:`Trade` 加 `riskPrice`

目前 `Trade` 未保留風險距離,算不出成本。新增 `riskPrice: number`(= 停損距離,價格單位),
評估時計算:

```
netR = rMultiple − 0.002 × entryPrice / riskPrice
```

這次比較特別需要淨值:SNR 進場點貼著水平位,與現有策略的進場位置分布不同,
每筆成本佔 R 的比例不會一樣,只看 gross avgR 會誤導。

### 抽出 `src/backtest-harness.ts`

`scripts/enhance-backtest.ts` 裡的 `loadKlines` / `split` / `htfEntryFilter` / `barMs` /
`HTF_MAP` / `SYMBOLS` 正是本次所需。直接複製會變成第三份,故搬到 `src/backtest-harness.ts`
供兩個腳本共用。`enhance-backtest.ts` 改為 import,行為不變。

僅限本次用得到的部分,不擴大為無關重構。

一併修掉搬遷時會暴露的問題:`enhance-backtest.ts` 的 `CACHE_DIR` 是某次 session 的
scratchpad 絕對路徑(已失效),搬進共用模組前改為 `./.cache/klines` 並加入 `.gitignore`。

### 新腳本 `scripts/snr-backtest.ts`

輸出三列對照,每列再分 MTF off / MTF on,同時報 gross 與 net avgR:

```
baseline(現有 4h 策略)   MTF off  n=... avgR=... netAvgR=... minPF=... 賺錢=x/8
                          MTF on   ...
SNR-A 反轉                MTF off  ...
                          MTF on   ...
SNR-B 突破                MTF off  ...
                          MTF on   ...
```

用法:`bun run snr-backtest [interval]`,預設 4h(需在 `package.json` 的 `scripts` 加此捷徑,
與既有的 `backtest` / `enhance-backtest` 一致)。

## 評估準則(先講定,不事後挪動)

條件:4h、8 主流幣(`SYMBOLS`)、樣本外 test 段(後 30%)、MTF on、含成本。

採用需**同時**滿足:

1. 淨 avgR > baseline 的淨 avgR
2. 賺錢標的數 ≥ baseline
3. n ≥ 100

未達標 → 寫進 `docs/strategy-backtest.md` 當否定結論,**不**進 `STRATEGIES`、
**不**進紙上交易、**不**接實盤。

達標 → 另起一次 brainstorm 討論如何併入(並行紙上策略?第二輪變體?),不在本次範圍。

## 測試

- `src/snr.test.ts`:合成 K 線,人工造出明確的支撐反彈與壓力突破情境,驗 A/B 進場判斷、
  邊界(剛好落在 `touchATR` 內外)、`NaN` 回傳 `null`。
- `src/backtest.test.ts`:補 signal hook 測試,確認**不傳 `signal` 時行為與現況完全相同**;
  傳入自訂 signal 時走自訂路徑。`riskPrice` 欄位正確。
- `bun run check` 必須通過。

## 不做的事

- 不改 `signal.ts` 的 `srFilter`(它是過濾器,與本次的進場策略互不干擾)
- 不加第三條並行策略、不碰 `strategies.ts`
- 不碰 OKX 實盤路徑
- 不做 1h / 1d 週期(1h 已知被成本壓垮、1d 樣本太薄)
