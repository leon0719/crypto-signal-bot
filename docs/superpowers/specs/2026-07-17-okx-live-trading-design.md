# OKX 自動下單 + Slack 開關 設計 spec

日期:2026-07-17
狀態:已確認(使用者拍板)

## 目標

把 4h 策略的掃描訊號接上 OKX 真實下單,並可透過 Slack 指令啟動/停止自動下單、
查詢餘額與倉位。紙上交易記帳照常運作,實盤為「加掛」,兩者可對照滑價與執行差異。

## 已拍板的關鍵決策

| 決策點 | 結論 |
|---|---|
| 執行引擎 | 程式直連 OKX v5 REST API(零相依手寫 client)。OKX MCP 不參與自動化,保留給對話中手動查倉/干預 |
| Slack 指令接收 | 排程器內每 30 秒輪詢 `conversations.history` 控制頻道 |
| 出場管理 | 進場時掛交易所端 attached TP/SL(2×ATR 停損、3×ATR 止盈),排程器掛掉不影響保護 |
| 實盤範圍 | 只有 4h 策略;1h 續留靜音紙上 A/B |
| 部位大小 | 沿用紙上規則:OKX 實際 USDT 權益 × 每筆風險 1%、槓桿 3x |
| 停止語義 | `停止自動下單` = 只停新倉(既有倉交給 TP/SL);另有 `緊急平倉` = 停止+撤保護單+市價平所有自動倉 |
| 上線方式 | 先 dry-run 一週(`LIVE_MODE=dry` 預設),驗證後切 `LIVE_MODE=real` |

## 架構與資料流

```
scheduler.ts(常駐,單一行程)
├─ 掃描迴圈(現有):每小時 :02 → detect.ts
│    └─ 4h 策略新機會 → 紙上記帳(不變)→ 若自動下單開啟 → live.ts 下單
└─ 控制迴圈(新增):每 30 秒輪詢 Slack 控制頻道 → 路由指令 → 回訊
```

新增模組:

- `src/okx.ts` — OKX v5 REST client。`crypto.subtle` HMAC-SHA256 + base64 簽名
  (`timestamp + method + requestPath + body`),headers `OK-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE`。
  風格比照 `bybit.ts`(typed error、單一 `okxRequest()` 包裝)。
- `src/live.ts` — 訊號 → 護欄 → 部位計算 → 下單 → 記帳/通報。
- `src/control.ts` — Slack 輪詢、指令路由、開關狀態持久化。

env 新增:`OKX_API_KEY`、`OKX_API_SECRET`、`OKX_API_PASSPHRASE`、
`SLACK_CONTROL_CHANNEL_ID`、`LIVE_MODE`(`dry`|`real`,預設 `dry`)。
OKX API key 權限只開「讀取+交易」,不開提幣。Slack bot token 需加 `channels:history` scope。

## 下單邏輯(src/live.ts)

每個 4h 新機會依序:

1. **開關與護欄**(任一不過 → 跳過並記錄原因):
   - 自動下單開關 = 開啟
   - 該幣無既有「自動」倉位(live ledger 內)
   - 自動倉位總數 < 上限(預設 4)
   - 冪等鍵 `symbol + bar 開盤時間` 未下過單(存 ledger)
2. **部位計算**:`GET /api/v5/account/balance` 取 USDT 權益 →
   風險額 = 權益 × 1% → 幣量 = 風險額 ÷ (2×ATR 停損距離) →
   以 `instruments` 的 `ctVal`/`lotSz`/`minSz` 換算並取整為合約張數;設 3x 槓桿(逐倉)。
   幣別對映:`BTCUSDT` → `BTC-USDT-SWAP`。
3. **下單**:市價單 + attached TP/SL(`attachAlgoOrds`,停損 2×ATR、止盈 3×ATR,
   與紙上規則一致)。出場全權交給交易所。
4. **記帳與通報**:寫 `./data/live-ledger.json`(訂單 ID、冪等鍵、進場價、TP/SL、張數、時間),
   成功/失敗皆推 Slack。
5. **dry-run**:`LIVE_MODE=dry` 時步驟 1–2 照跑,步驟 3 不打 API,
   改推 Slack「【模擬】會下這張單:…」(含張數、TP/SL、名目價值)。
   步驟 4 照常寫 ledger 並標記 `mode: "dry"`(冪等與倉位上限才能如實演練);
   切 real 時換新 ledger 檔或清除 dry 紀錄,dry 紀錄不算入 real 的倉位上限。

錯誤處理 **fail-closed**:餘額查詢失敗、規格取不到、下單被拒 → 該筆放棄 + Slack 告警,
絕不用猜的參數下單。網路層錯誤最多重試一次;業務錯誤(OKX code ≠ 0)不重試。

## Slack 控制(src/control.ts)

排程器內第二條 async 迴圈,每 30 秒讀控制頻道新訊息(記 `latest ts`,
只處理輪詢啟動之後的訊息,避免重啟重播歷史指令)。指令為純文字完全比對:

| 指令 | 動作 |
|---|---|
| `啟動自動下單` | 開啟開關,回「✅ 已啟動」 |
| `停止自動下單` | 停開新倉,既有倉留給交易所 TP/SL,回確認 |
| `緊急平倉` | 停止 + 撤保護單 + 市價平所有 live ledger 內的自動倉(不碰手動倉),逐筆回報 |
| `狀態` | 開關狀態、模式 dry/real、自動倉位數/上限、下次掃描時間 |
| `餘額` | USDT 總權益、可用餘額、未實現損益 |
| `倉位` | 逐筆列出合約倉位:幣種、方向、張數、均價、標記價、未實現損益(±%)、TP/SL;標註自動/手動 |
| `成績` | 立即產出 4h 紙上成績單推頻道(重用 paper-report 彙整邏輯) |
| `指令` | 回覆可用指令清單 |

- 開關狀態持久化 `./data/live-control.json`;排程器重啟沿用上次狀態,
  並推 Slack「排程器已重啟,自動下單目前:開啟/關閉(模式:dry/real)」。
  檔案不存在時預設關閉(fail-closed)。
- 查詢指令唯讀,失敗回錯誤訊息,不影響開關狀態。

## 測試

`bun:test` + stub `globalThis.fetch`(依 URL 分路 `/account/balance`、`/trade/order`、
`/account/positions`、`/conversations.history`…),`mock.restore()` in `afterEach`。重點案例:

- OKX 簽名字串組成正確(固定 timestamp 驗 HMAC 結果)
- 張數換算:`ctVal`/`lotSz` 取整、低於 `minSz` 時放棄下單
- 冪等:同 `symbol+bar` 不重複下單
- fail-closed 各分支(餘額失敗、規格失敗、下單被拒)
- 緊急平倉只平 ledger 內的自動倉
- dry-run 不打下單 API 但推 Slack 模擬訊息
- 控制迴圈:指令路由、`latest ts` 前的訊息不處理、重啟狀態還原

## 風險邊界(刻意不做)

- 不做自動參數優化、不做加倉/攤平、不動 trailing(維持與已驗證紙上規則一致)。
- 「同輪 ≥3 支高相關同方向只留最強」護欄本版不做,先靠倉位上限 4 擋;
  之後獨立實作且紙上/實盤同步改,保持對照性。
- 排程器在本機,電腦睡眠 = 不開新倉;既有倉有交易所端 TP/SL,無裸奔風險。

## 上線流程

1. 實作完成、`bun run check` + `bun test` 全綠。
2. `LIVE_MODE=dry` 跑一週:驗證張數計算、合約規格、Slack 開關/查詢指令。
3. 確認無誤後切 `LIVE_MODE=real`,首倉人工盯 Slack 回報與 OKX App 對照。
4. 實盤與紙上帳本對照滑價/執行差異,納入每日成績單解讀。
