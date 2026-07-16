# 並行 1h 紙上交易策略(A/B 前向測試)設計

日期:2026-07-16
狀態:已與使用者確認

## 目標

在現行 4h 紙上交易之外,新增一個 **1h 週期** 的並行策略 B,獨立記帳,
每日成績單推播到 **另一個 Slack 頻道**,前向比較兩個週期哪個表現較好。

## 非目標

- 不推播 1h 策略的進場訊號(靜音記帳,只推每日成績單)。
- 不改變 4h 策略的任何行為:同一份狀態檔、帳本、Slack 頻道、排程時點。
- 不改訊號引擎、幣種清單、風險參數 —— 兩策略唯一變因是週期(4h vs 1h),
  A/B 結論才乾淨。
- 不做自動參數優化(見 memory:strategy-backtest-findings)。

## 背景依據

樣本外回測(增強全開、MTF 疊加):4h avgR ≈ +0.17、1h avgR ≈ +0.05。
1h 進出更頻繁、更吃手續費(來回 0.2% 同樣計入),此前向測試驗證 1h 在
真實市場是否仍有正期望。

## 策略設定(核心抽象)

新檔 `src/strategies.ts`,策略 = 一組純資料設定:

```ts
export interface Strategy {
  name: string;          // 顯示於成績單標題與 log
  interval: string;      // 掃描週期
  htf: string;           // 大週期確認
  statePath: string;     // 去重狀態檔
  ledgerPath: string;    // 紙上交易帳本
  pushSignals: boolean;  // 是否推新機會訊號到 Slack
  channelEnv: string;    // 成績單/訊號使用的 Slack channel 環境變數名
}

export const STRATEGIES: Strategy[] = [
  { name: "4h", interval: "4h", htf: "1d",
    statePath: "./data/signal-state.json", ledgerPath: "./data/paper-ledger.json",
    pushSignals: true,  channelEnv: "SLACK_CHANNEL_ID" },
  { name: "1h", interval: "1h", htf: "4h",
    statePath: "./data/signal-state-1h.json", ledgerPath: "./data/paper-ledger-1h.json",
    pushSignals: false, channelEnv: "SLACK_CHANNEL_ID_1H" },
];
```

幣種清單(`SYMBOLS`)、風險參數(2000U、1% 風險、ATR 動態槓桿、來回手續費 0.2%)
兩策略共用同一份。`PaperConfig.intervalMs` 由 `interval` 換算(1h 策略 = 3,600,000ms),
影響進場棒對齊與結算判定。

## 改動點

### 1. `src/scan.ts` — 週期參數化

`runScan()` 改為 `runScan(interval, htf)`(或收 `Strategy`);
現有常數 `INTERVAL`/`HTF` 保留為 4h 預設值供既有呼叫端使用。
`evalOiDir` 與 `HTF_MAP` 均已支援 1h(1h → HTF 4h),無需改動。

### 2. `src/slack.ts` — 可選頻道

`postMessage(text, channelId?)`:未傳時沿用 `SLACK_CHANNEL_ID`(現行為不變);
傳入時發到指定頻道。缺 token 或指定頻道未設定照舊拋錯。

### 3. `scripts/detect.ts` — 依策略執行

改為接受策略名參數(`bun scripts/detect.ts 1h`,預設 `4h` 保持相容):

- 掃描 → 篩機會 → 與該策略的 `statePath` 去重。
- `pushSignals: true` 才推新機會訊號(推播失敗撤回 key 的既有邏輯不變)。
- 紙上交易記帳寫入該策略的 `ledgerPath`,`intervalMs` 依策略週期。
- log 前綴帶策略名,例:`[紙上交易:1h] 新開 2…`。

### 4. `scripts/paper-report.ts` — 依策略出成績單

接受策略名參數:讀該策略帳本、成績單標題帶策略名
(`📊 紙上交易成績單 · 4h 策略 · 截至 YYYY-MM-DD`),推到該策略的頻道。
`src/paper.ts` 的 `buildScorecard` 增加策略標籤與基準文字參數
(4h 註解沿用「回測 4h avgR ≈ +0.10」;1h 改為「回測 1h avgR ≈ +0.05」),
未傳時維持現行輸出。

### 5. `scripts/scheduler.ts` — 每小時觸發

- 排程改為 **每小時** 整點後 2 分(UTC)觸發。
- 每次觸發:先跑 1h 策略;若當前 UTC 小時 ∈ {0,4,8,12,16,20} 再跑 4h 策略。
- 每個策略以獨立子行程執行(`bun scripts/detect.ts <name>`),互不拖垮。
- UTC0 那輪之後,兩張成績單各推各的頻道(依序跑兩次 paper-report)。
- `src/schedule.ts` 的 `nextRunTime` 已支援任意小時集合,傳入 0–23 即可。

### 6. 環境變數

- 新增 `SLACK_CHANNEL_ID_1H`(使用者自行開新頻道、邀 bot 進頻道後設定)。
- 未設定時:1h 掃描與記帳照常執行,成績單推播失敗會 log 錯誤(fail-soft,
  不影響 4h 策略)。

## 資料流

```
scheduler(每小時 UTC :02)
  ├─ detect.ts 1h  → runScan(1h,4h) → 機會 → signal-state-1h 去重
  │      └─ 不推訊號;runPaper → paper-ledger-1h.json
  ├─ (逢 UTC 0/4/8/12/16/20) detect.ts 4h → 現行流程完全不變
  └─ (逢 UTC 0) paper-report.ts 4h → SLACK_CHANNEL_ID
              paper-report.ts 1h → SLACK_CHANNEL_ID_1H
```

## 錯誤處理

- 單一策略的掃描/記帳/推播失敗只影響該策略該輪(子行程隔離 + 各自 exitCode)。
- 1h 掃描 0 筆時同樣跳過、不更新去重狀態(沿用既有防抹除邏輯)。
- `SLACK_CHANNEL_ID_1H` 未設定 → 成績單推播拋錯被 log,帳本照常累積。

## 測試

- `src/strategies.test.ts`(新):設定完整性(路徑不重複、interval 合法、
  intervalMs 換算正確)。
- `src/scan.test.ts`(擴充):`runScan` 以 1h 參數呼叫時,kline/OI 請求帶 1h、
  HTF 帶 4h(fetch mock 驗 URL)。
- `src/slack.test.ts`(擴充):`postMessage` 帶 channelId 時 body 用指定頻道;
  不帶時沿用環境變數。
- `src/schedule.test.ts`(擴充):每小時模式的 `nextRunTime`;
  「UTC 小時是否跑 4h 策略」「是否推成績單」的純函式判斷。
- `src/paper.test.ts`(擴充):成績單標題含策略名;1h 基準註解。
