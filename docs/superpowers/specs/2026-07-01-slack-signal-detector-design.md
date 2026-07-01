# 定時偵測 + Slack 推播偵測器 — 設計文件

- 日期:2026-07-01
- 狀態:設計已核准,待寫實作計畫

## 目標

使用者目前只能在 LINE 主動查詢單一幣種。希望有一個**常駐服務定時掃描主流幣**,一旦出現通過三重確認的有效進場方向(做多/做空),就**主動推播到 Slack**,不必自己盯盤。

技術面輸出,非投資建議。

## 需求彙整(已與使用者確認)

- **執行環境**:本機 Docker 容器,常駐(方案 A:容器內 supercronic 排程)。
- **頻率**:對齊 4h K 棒收盤(00/04/08/12/16/20 UTC),收棒後約 2 分鐘跑一次。理由:引擎主訊號用**已收盤 4h 棒**計算,新訊號只在 4h 收盤時才可能出現,掃得更密不會有新結果。
- **偵測範圍**:重用 `scripts/scan-market.ts` 的 `SYMBOLS`(15 個主流幣)、`INTERVAL=4h`、`HTF=1d`。
- **觸發條件**:有效方向(LONG/SHORT)且**新出現**才推;同幣同方向不重推,直到訊號消失才重置。
- **通知管道**:Slack `chat.postMessage`(bot token),發到頻道 `C0BEBHYB56E`(`#cry`,workspace「Riversoft Inc.」,bot 為 `ai_team_bot`)。已實測連線成功。
- **密鑰處理**:token 放 gitignore 的 `.env`,程式只從環境變數讀,絕不進 git。

## 架構

單一新增的偵測進入點,重用現有訊號引擎;對現有掃描腳本做一處小重構以共用邏輯。

### 元件

#### `src/scan.ts`(新:抽出共用掃描核心)

把目前寫死在 `scripts/scan-market.ts` 的掃描迴圈抽成純函式:

```ts
export interface ScanRow {
  symbol: string;
  dir: "LONG" | "SHORT" | "NEUTRAL";   // 原始引擎方向
  effective: "LONG" | "SHORT" | "NEUTRAL" | "DOWNGRADED"; // 套用衝突後的有效方向
  score: number;
  regime: string;      // 4h 型態:趨勢/盤整/中性
  adx: number;
  htf1d: number | null;
  oi: number | null;   // -1 | 0 | 1
  price: number;       // 即時價(取不到退收盤價)
  atr: number;
  htfConflict: boolean;
  oiConflict: boolean;
}

export async function runScan(): Promise<ScanRow[]>;
```

- 邏輯與現有 `scan-market.ts` 完全一致(4h 已收盤棒 `evalAt` + 1d HTF 分數 + OI 方向 + 衝突降級),只是回結構化資料而非印字串。
- `scripts/scan-market.ts` 改為呼叫 `runScan()` 再印原本的 tab 表格,**輸出格式不變**(既有使用方式與 order-recommendations skill 不受影響)。

#### `src/slack.ts`(新:Slack 客戶端)

```ts
export async function postMessage(text: string): Promise<void>;
```

- 用 `fetch` 打 `https://slack.com/api/chat.postMessage`,`Authorization: Bearer ${SLACK_BOT_TOKEN}`,body 帶 `channel = SLACK_CHANNEL_ID`、`text`。
- 讀 env:`SLACK_BOT_TOKEN`、`SLACK_CHANNEL_ID`。缺任一則丟明確錯誤。
- 回應 `ok:false` 時丟錯(附 Slack error 字串),供上層 log。
- 零 runtime 相依,只用 Web `fetch`,與專案慣例一致。

#### `scripts/detect.ts`(新:偵測進入點)

流程:

1. `const rows = await runScan()`。
2. 篩有效機會:`effective ∈ {LONG, SHORT}`(即 `dir` 有方向且無 HTF/OI 衝突降級)。
3. 讀去重狀態 `data/signal-state.json`。
4. 對每個有效機會算 `key = ${symbol}:${effective}`;若 key 不在狀態內 → 列為「新機會」。
5. 更新狀態:狀態內容替換為「本輪所有有效機會的 key 集合」(本輪不再有效的 key 自動移除,達成「消失後重出會重推」)。
6. 若有新機會 → 組 Slack 訊息 → `postMessage`。無新機會 → 不發(靜默)。
7. 全程 log 到 stdout(容器日誌可查)。

### 去重狀態

- 檔案:`data/signal-state.json`,格式 `{ "active": ["LINKUSDT:SHORT", "BNBUSDT:SHORT"], "updatedAt": "<ISO>" }`。
- 透過 docker volume 掛載,容器重啟不遺失。
- 語意:某 `key` 出現在上一輪 `active` 就不重推;本輪重算整份 `active`,消失的 key 被丟出,下次再出現即視為新機會。

### 推播內容

一則 Slack 訊息包含開頭摘要 + 每個新機會一段 + 結尾免責:

```
⏰ 4h 掃描 · 發現 2 個新進場機會

🔴 LINKUSDT 做空
   4h趨勢 · ADX 36 · 日線 −86.9 · OI −1
   進場 7.155 ｜ 停損 7.417 (2×ATR) ｜ 目標 6.762 (3×ATR)

🔴 BNBUSDT 做空
   4h趨勢 · ADX 49 · 日線 −37.4 · OI −1
   進場 544.3 ｜ 停損 558.6 (2×ATR) ｜ 目標 522.85 (3×ATR)

⚠️ 技術面訊號,非投資建議。務必照停損操作。
```

- 停損停利算法(與 order-recommendations 一致):
  - 做空:停損 = price + 2×ATR;目標 = price − 3×ATR。
  - 做多:停損 = price − 2×ATR;目標 = price + 3×ATR。
- 綠/紅 emoji 依方向(做多 🟢 / 做空 🔴)。

### Docker(方案 A:supercronic 常駐)

- **`Dockerfile`**:`oven/bun` base;下載 supercronic 靜態 binary(釘住版本 + checksum);複製原始碼;`bun install --frozen-lockfile`;`CMD ["supercronic", "/app/crontab"]`。
- **`crontab`**:`2 0,4,8,12,16,20 * * * cd /app && bun scripts/detect.ts`(UTC)。
- **`docker-compose.yml`**:`build .`、`env_file: .env`、`volumes: ["./data:/app/data"]`、`restart: unless-stopped`。
- **`.env`(gitignore)**:`SLACK_BOT_TOKEN=...`、`SLACK_CHANNEL_ID=C0BEBHYB56E`。
- **`.env.example`(進 git)**:同上但值留空,當範本。
- `.gitignore` 追加 `.env` 與 `data/`。

## 錯誤處理

- 單一幣 fetch 失敗:引擎/`runScan` 內 fail-soft,跳過該幣(現有行為)。
- Slack 發送失敗:log 記錄錯誤,不中斷流程。
- 整輪掃描全數失敗(0 rows):log 警示;預設**不**發 Slack 錯誤訊息(避免噪音),此為明確取捨,日後可加開關。
- supercronic:`restart: unless-stopped` 確保容器重啟後排程續跑;錯過的 4h 棒因「新出現才推」語意會在下次執行時補推當前仍有效的機會。

## 測試(沿用現有 stub fetch 模型)

- `src/scan.test.ts`:stub Bybit fetch,驗證衝突降級與 `effective` 判定。
- `scripts/detect` 去重邏輯:抽成可測純函式 `diffNewOpportunities(rows, prevActive)`,單元測試新出現/消失/重現三情境。
- `src/slack.test.ts`:stub fetch,驗證 payload(channel、text)與 `ok:false` 拋錯。
- Slack 訊息組裝 `buildSlackText(opportunities)`:純函式,快照式驗證格式與停損停利數字。
- `bun test` 與 `tsc --noEmit` 續在 CI 跑。

## 明確不做(YAGNI)

- 不改 Cloudflare Worker,不加 `scheduled()`/KV/cron(CLAUDE.md 記載刻意移除,維持現狀)。
- 不做多頻道、Slack 互動按鈕、thread。
- 不自動下單;推播僅供人工決策。
- 不做整輪失敗的 Slack 警示(預設關)。
