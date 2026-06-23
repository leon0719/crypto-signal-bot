# crypto-signal-bot

把 Go 版 `crypto-signal` 的技術分析邏輯改寫成 **JavaScript**,部署到 **Cloudflare Worker**,透過 **LINE webhook** 讓你在 LINE 官方帳號(OA)直接傳幣別、即時收到多空評分與進出場/槓桿建議。

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
| `src/index.js` | Worker 入口,webhook 路由 + 簽章驗證 |
| `src/line.js` | LINE 簽章驗證(Web Crypto HMAC-SHA256)、reply API |
| `src/command.js` | 解析使用者文字 → `{symbol, interval, market, leverage}` |
| `src/okx.js` | 抓 OKX K 線與資金費率 |
| `src/ta.js` | 技術指標(EMA/RSI/MACD/Bollinger/ATR/Stochastic/ADX/OBV) |
| `src/signal.js` | 加權評分 + ADX 趨勢/盤整自動切換 |
| `src/format.js` | 組成 LINE 文字回覆(emoji 取代顏色) |
| `src/analyze.js` | 串接以上,輸入文字 → 回覆字串 |

## 在 LINE 怎麼用

直接輸入(空白分隔,順序不拘):

| 輸入 | 意義 |
|------|------|
| `btc` | BTCUSDT、1h、合約 |
| `eth 4h` | 換週期 |
| `sol 15m 10x` | 加槓桿,推算強平價 |
| `btc spot` | 現貨 |
| `help` / `幫助` | 使用說明 |

回覆範例:

```
📊 BTCUSDT(OKX 合約 · 1h)
價格 62,980
🟢 做多(看漲)　評分 +42/100(中等)
狀態 趨勢｜ADX 28
資金費率 0.0034%/8h
趨勢▲ EMA 快慢線▲ MACD▲ OBV 量能▲ RSI▼ ...
🎯 進場 ~62,980
🔴 停損 61,900(-1.7%)
🟢 停利 64,500(+2.4%)
賺賠比 1.4 : 1
⚡ 槓桿 10× ...
```

## 本機開發

```bash
bun install
cp .dev.vars.example .dev.vars   # 填入 LINE 憑證
bun run dev                      # http://localhost:8787
bun test                         # 單元測試
bun run check                    # biome 檢查
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

## 與 Go 版的關係

指標與評分邏輯完全對齊 Go 版 `crypto-signal`(同樣的 EMA/MACD/RSI/BB/ATR/Stoch/ADX/OBV、ADX regime 切換、ATR 停損停利、槓桿強平檢查)。差別:

- Go 版是 CLI,功能更全(回測、optimize/walk-forward、watch)。
- JS 版是 LINE 互動,只做即時 `analyze`(回測類運算不適合放 webhook 即時回覆)。

## 限制

- 為求 webhook 即時回應,K 線單次抓 OKX 300 根(不翻頁);EMA200 在資料剛好時可能算不出,會提示改用較小週期。
- 強平價為粗估(忽略維持保證金與手續費),實際會更近一點。
