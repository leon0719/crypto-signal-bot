// 解析使用者在 LINE 輸入的文字訊息。
//
// 支援格式(空白分隔,順序不拘):
//   btc                  → BTCUSDT 1h 合約
//   eth 4h               → ETHUSDT 4h
//   sol 15m 10x          → SOLUSDT 15m,槓桿 10 倍
//   btc spot             → 現貨
//   help / 幫助 / ?      → 使用說明

const INTERVAL_RE = /^\d+[mhdwM]$/;
const LEVERAGE_RE = /^x?(\d+(?:\.\d+)?)x?$/i;

export function parseCommand(text) {
  const raw = (text || "").trim();
  if (!raw) return { help: true };

  const lower = raw.toLowerCase();
  if (["help", "?", "？", "幫助", "說明", "/help", "menu", "選單"].includes(lower)) {
    return { help: true };
  }

  const tokens = raw.split(/\s+/);
  let symbol = tokens[0].replace(/^\//, "").toUpperCase();
  if (!/(USDT|USDC|USD)$/.test(symbol)) symbol += "USDT";

  let interval = "1h";
  let market = "futures";
  let leverage = 1;

  for (const t of tokens.slice(1)) {
    const low = t.toLowerCase();
    if (INTERVAL_RE.test(t)) {
      interval = t;
    } else if (["spot", "現貨"].includes(low)) {
      market = "spot";
    } else if (["futures", "swap", "合約", "永續"].includes(low)) {
      market = "futures";
    } else if (LEVERAGE_RE.test(t) && /x/i.test(t)) {
      leverage = Number(t.match(LEVERAGE_RE)[1]);
    }
  }

  return { help: false, symbol, interval, market, leverage };
}

export function helpText() {
  return [
    "📈 加密貨幣訊號機器人",
    "",
    "直接輸入幣別即可分析,例如:",
    "・btc            (BTCUSDT 1h 合約)",
    "・eth 4h         (換週期)",
    "・sol 15m 10x    (加槓桿,推算強平)",
    "・btc spot       (現貨)",
    "",
    "週期:1m 5m 15m 1h 4h 1d 1w",
    "資料來源:OKX。指標僅供參考,非投資建議。",
  ].join("\n");
}
