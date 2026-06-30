// 解析使用者在 LINE 輸入的文字訊息。
//
// 支援格式(空白分隔,順序不拘):
//   btc                  → BTCUSDT 4h 合約
//   eth 1h               → ETHUSDT 1h
//   sol 15m 10x          → SOLUSDT 15m,槓桿 10 倍
//   btc spot             → 現貨
//   help / 幫助 / ?      → 使用說明

import type { Command, Market } from "./types.js";

const INTERVAL_RE = /^\d+[mhdwM]$/;
const LEVERAGE_RE = /^x?(\d+(?:\.\d+)?)x?$/i;
const HELP_KW = ["help", "?", "？", "幫助", "說明", "/help", "menu", "選單"];

export function parseCommand(text: string): Command {
  const raw = (text || "").trim();
  if (!raw) return { help: true };
  if (HELP_KW.includes(raw.toLowerCase())) return { help: true };

  const tokens = raw.split(/\s+/);
  let symbol = tokens[0].replace(/^\//, "").toUpperCase();
  if (!/(USDT|USDC|USD)$/.test(symbol)) symbol += "USDT";

  let interval = "4h";
  let market: Market = "futures";
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
      const m = t.match(LEVERAGE_RE);
      if (m) leverage = Number(m[1]);
    }
  }

  return { help: false, symbol, interval, market, leverage };
}

export function helpText(): string {
  return [
    "📈 加密貨幣訊號機器人",
    "",
    "直接輸入幣別即可分析,例如:",
    "・btc            (BTCUSDT 4h 合約)",
    "・eth 1d         (換週期)",
    "・sol 4h 10x     (加槓桿,推算強平)",
    "・btc spot       (現貨)",
    "",
    "週期:主推 4h(預設)、1d;短於 1h 含成本偏負,不建議。",
    "資料來源:OKX。",
  ].join("\n");
}
