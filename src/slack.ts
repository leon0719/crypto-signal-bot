// Slack 通知:chat.postMessage(bot token)。零相依,只用 fetch。密鑰由環境變數提供。
import type { Opportunity } from "./detect.js";
import { defaultConfig } from "./signal.js";

const dirLabel = (dir: "LONG" | "SHORT") => (dir === "SHORT" ? "做空" : "做多");
const dirEmoji = (dir: "LONG" | "SHORT") => (dir === "SHORT" ? "🔴" : "🟢");
const fmtHtf = (n: number | null) => (n == null ? "—" : n.toFixed(1));

// 組一則 Slack 純文字訊息:摘要 + 每個機會一段 + 免責。
export function buildSlackText(opps: Opportunity[]): string {
  // 倍數標籤取自同一份設定,避免文案與實際停損脫節(2026-07-23 前曾寫死 2×ATR)。
  const { stopATR, takeATR } = defaultConfig();
  const header = `⏰ 4h 掃描 · 發現 ${opps.length} 個新進場機會`;
  const blocks = opps.map(
    (o) =>
      `${dirEmoji(o.dir)} *${o.symbol} ${dirLabel(o.dir)}*\n` +
      `   4h${o.regime} · ADX ${o.adx.toFixed(0)} · 日線 ${fmtHtf(o.htf1d)} · OI ${o.oi ?? "—"}\n` +
      `   進場 ${o.entry} ｜ 停損 ${o.stop} (${stopATR}×ATR) ｜ 目標 ${o.target} (${takeATR}×ATR)`,
  );
  const footer = "⚠️ 技術面訊號,非投資建議。務必照停損操作。";
  return [header, "", ...blocks, "", footer].join("\n");
}

// 發送到 Slack。channelId 未指定時用 SLACK_CHANNEL_ID。缺 token/頻道或 Slack 回 ok:false 皆拋錯。
export async function postMessage(text: string, channelId?: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = channelId ?? process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    throw new Error("缺少 SLACK_BOT_TOKEN 或 SLACK_CHANNEL_ID 環境變數");
  }
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
    // 逾時中止,避免掛住排程。
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack 發送失敗:${data.error ?? "unknown"}`);
}
