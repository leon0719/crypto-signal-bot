# crypto-signal-bot

用 **TypeScript** 實作一套技術分析訊號引擎,部署到 **Cloudflare Worker**,透過 **LINE webhook** 讓你在 LINE 官方帳號(OA)直接傳幣別、即時收到多空評分與進出場/槓桿建議。

> 純運算、無資料庫、無 LLM。你發訊息 → Worker 收 webhook → 回覆分析。指標僅供參考,非投資建議。

## 架構

```
LINE App ──訊息──▶ LINE Platform ──webhook POST /webhook──▶ Cloudflare Worker
                                                              │ 驗證簽章
                                                              │ 解析指令(幣別/週期/槓桿)
                                                              │ 抓 OKX K 線 → 算指標評分
                                                              ▼
LINE App ◀──reply token 回覆────────────────────────────── replyText()
```

| 檔案 | 職責 |
|------|------|
| `src/types.ts` | 全專案共用型別 |
| `src/index.ts` | Worker 入口,webhook 路由 + 簽章驗證 + 載入動畫 |
| `src/line.ts` | LINE 簽章驗證(Web Crypto HMAC-SHA256)、reply / loading API |
| `src/command.ts` | 解析使用者文字 → `Command`(含 `multi` 多週期) |
| `src/okx.ts` | 抓 OKX K 線(自動翻頁)、資金費率、可用幣種 |
| `src/ta.ts` | 技術指標(EMA/RSI/MACD/Bollinger/ATR/Stochastic/ADX/OBV) |
| `src/signal.ts` | 加權評分 + ADX 趨勢/盤整自動切換 |
| `src/suggest.ts` | 代號打錯時的模糊推薦 |
| `src/format.ts` | 組 LINE Flex 圖卡 + carousel + quick reply |
| `src/analyze.ts` | 串接以上 + 多週期確認(MTF) |
| `scripts/setup-richmenu.ts` | 一次性建立 LINE 圖文選單 |

用 **TypeScript**(嚴格模式)。新增頁面/功能後跑 `bun run check`(biome + tsc)。

## 在 LINE 怎麼用

直接輸入(空白分隔,順序不拘):

| 輸入 | 意義 |
|------|------|
| `btc` | BTCUSDT、1h、合約(含 4h 大週期確認) |
| `eth 4h` | 換週期 |
| `sol 15m 10x` | 加槓桿,推算強平價 |
| `btc spot` | 現貨 |
| `btc multi` | 一次看 15m/1h/4h 多張卡(carousel) |
| `help` / `幫助` | 使用說明 |

回覆是 Flex 圖卡(下方有換週期 quick reply 按鈕);分析期間會先顯示「輸入中…」載入動畫。

## 本機開發

```bash
bun install
cp .dev.vars.example .dev.vars   # 填入 LINE 憑證
bun run dev                      # http://localhost:8787
bun test                         # 單元 + 整合測試
bun run check                    # biome + tsc 型別檢查
```

本機測 webhook 可用 `cloudflared tunnel` 或 `ngrok` 把 8787 對外,再填到 LINE。

## 部署

1. **建立 LINE Messaging API channel**
   到 [LINE Developers Console](https://developers.line.biz/) 建一個 Provider → Messaging API channel,取得:
   - **Channel access token**(long-lived)
   - **Channel secret**

2. **設定 Worker secrets 並部署**
   ```bash
   bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   bunx wrangler secret put LINE_CHANNEL_SECRET
   bun run deploy
   ```
   部署後會得到 `https://crypto-signal-bot.<你的子域>.workers.dev`。

3. **回填 webhook URL**
   在 LINE channel 的 Messaging API 設定:
   - Webhook URL 填 `https://crypto-signal-bot.<...>.workers.dev/webhook`
   - 開啟「Use webhook」
   - 關閉「Auto-reply messages / 加入好友的歡迎訊息」(避免官方罐頭訊息干擾)
   - 按「Verify」確認回 200

4. 用手機加官方帳號為好友,傳 `btc` 試試。

## 環境變數

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | 回覆訊息用 |
| `LINE_CHANNEL_SECRET` | 驗證 webhook 簽章用 |

本機放 `.dev.vars`,正式環境用 `wrangler secret put`。

## 分析方法

EMA/MACD/RSI/BB/ATR/Stoch/ADX/OBV 多指標加權,用 ADX 自動在「趨勢」與「盤整」兩套權重間切換;支撐/壓力同時參考動態均線(EMA/布林)與價格轉折高低點(swing);ATR 動態停損停利(1.5×/3.0×ATR,R:R 2:1)並附槓桿強平檢查。只做即時 `analyze`,不含回測。

## 限制

- 為求 webhook 即時回應,K 線單次抓 OKX 300 根(不翻頁);EMA200 在資料剛好時可能算不出,會提示改用較小週期。
- 強平價為粗估(忽略維持保證金與手續費),實際會更近一點。
