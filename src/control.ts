// Slack 控制迴圈:輪詢控制頻道新訊息 → 指令路由 → 執行 → 回覆。
// 指令採 trim 後完全比對(誤觸風險最低);查詢類唯讀,失敗回錯誤訊息不影響開關。
import type { LiveConfig } from "./live.js";
import {
  readControlState,
  readLiveLedger,
  withFileLock,
  writeControlState,
  writeLiveLedger,
} from "./live-state.js";
import {
  closePosition,
  fetchPositions,
  fetchUsdtBalance,
  type OkxCreds,
  type OkxPosition,
} from "./okx.js";

export type ControlCommand =
  | "start"
  | "stop"
  | "panic"
  | "status"
  | "balance"
  | "positions"
  | "report"
  | "help";

const COMMANDS: Record<string, ControlCommand> = {
  啟動自動下單: "start",
  停止自動下單: "stop",
  緊急平倉: "panic",
  狀態: "status",
  餘額: "balance",
  倉位: "positions",
  成績: "report",
  指令: "help",
};

export function parseCommand(text: string): ControlCommand | null {
  return COMMANDS[text.trim()] ?? null;
}

export interface ControlDeps {
  cfg: LiveConfig;
  creds: OkxCreds;
  post(text: string): Promise<void>; // 回覆到控制頻道
  runReport(): Promise<void>; // 「成績」:觸發 4h 成績單推播
  nextScanText(): string; // 「狀態」:下次掃描時間
  slackToken: string;
  channel: string;
}

const HELP_TEXT = [
  "可用指令(輸入完整字串):",
  "• 啟動自動下單 — 開啟訊號自動下單",
  "• 停止自動下單 — 停開新倉(既有倉交給交易所 TP/SL)",
  "• 緊急平倉 — 停止並市價平掉所有自動倉位",
  "• 狀態 — 開關/模式/倉位數/下次掃描",
  "• 餘額 — USDT 權益/可用/未實現",
  "• 倉位 — 目前合約倉位(標註自動/手動)",
  "• 成績 — 立即推 4h 紙上成績單",
  "• 指令 — 本清單",
].join("\n");

export async function handleCommand(cmd: ControlCommand, deps: ControlDeps): Promise<string> {
  const { cfg, creds } = deps;
  switch (cmd) {
    case "start": {
      await writeControlState(cfg.controlPath, { enabled: true });
      return `✅ 已啟動自動下單(模式:${cfg.mode})`;
    }
    case "stop": {
      await writeControlState(cfg.controlPath, { enabled: false });
      return "🛑 已停止自動下單;既有倉位由交易所 TP/SL 管理";
    }
    case "panic": {
      await writeControlState(cfg.controlPath, { enabled: false });
      // ledger 讀-改-寫span 與 executeLive(detect 子行程)可能並行,以檔案鎖序列化。
      return withFileLock(cfg.ledgerPath, async () => {
        const ledger = await readLiveLedger(cfg.ledgerPath);
        // real 倉位無論目前 cfg.mode 為何一律處理(見 I4:real→dry 切換後仍要能緊急平掉殘留真倉);
        // dry 倉位只在目前就是 dry 模式時才模擬平倉。
        const realOpens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === "real");
        const dryOpens =
          cfg.mode === "dry"
            ? ledger.positions.filter((p) => p.status === "OPEN" && p.mode === "dry")
            : [];
        if (realOpens.length === 0 && dryOpens.length === 0) {
          return "🛑 已停止;沒有自動倉位需要平倉";
        }

        // 平倉前對帳(見 I3):先抓一次交易所實際倉位,避免誤平「交易所已出場」或「方向不符的手動倉」。
        let posMap: Map<string, OkxPosition> | null = null;
        if (realOpens.length > 0) {
          try {
            const live = await fetchPositions(creds);
            posMap = new Map(live.map((p) => [p.instId, p]));
          } catch (e) {
            return `🚨 對帳失敗,未執行平倉:${(e as Error).message}(請手動處理)`;
          }
        }

        const lines: string[] = [];
        for (const p of realOpens) {
          const live = posMap?.get(p.instId);
          if (!live) {
            p.status = "CLOSED";
            p.closedAt = new Date().toISOString();
            p.closeReason = "交易所端已出場(緊急平倉前對帳)";
            lines.push(`✅ ${p.symbol} 交易所端已出場,帳本已同步`);
            continue;
          }
          const contradicts = p.dir === "SHORT" ? live.pos > 0 : live.pos < 0;
          if (contradicts) {
            lines.push(`⚠️ ${p.symbol} 交易所倉位方向與帳本不符,疑似手動倉,請手動處理`);
            continue;
          }
          try {
            await closePosition(creds, p.instId);
            p.status = "CLOSED";
            p.closedAt = new Date().toISOString();
            p.closeReason = "緊急平倉";
            lines.push(`✅ ${p.symbol} 已平倉`);
          } catch (e) {
            lines.push(`🚨 ${p.symbol} 平倉失敗:${(e as Error).message}(請手動處理)`);
          }
        }
        for (const p of dryOpens) {
          p.status = "CLOSED";
          p.closedAt = new Date().toISOString();
          p.closeReason = "【模擬】緊急平倉";
          lines.push(`✅ ${p.symbol} 已平倉`);
        }
        await writeLiveLedger(cfg.ledgerPath, ledger);
        return [`🛑 緊急平倉(${cfg.mode}):`, ...lines].join("\n");
      });
    }
    case "status": {
      const control = await readControlState(cfg.controlPath);
      const ledger = await readLiveLedger(cfg.ledgerPath);
      const opens = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === cfg.mode);
      const lines = [
        `⚙️ 自動下單:${control.enabled ? "開啟" : "關閉"}｜模式:${cfg.mode}`,
        `自動倉位 ${opens.length}/${cfg.maxPositions}${opens.length ? `(${opens.map((p) => p.symbol).join("、")})` : ""}`,
        `下次掃描:${deps.nextScanText()}`,
      ];
      // 見 I4:real→dry 切換後帳本可能仍有 real 倉位,狀態查詢時提醒不要漏看。
      if (cfg.mode === "dry") {
        const staleReal = ledger.positions.filter((p) => p.status === "OPEN" && p.mode === "real");
        if (staleReal.length > 0) {
          lines.push(`⚠️ 注意:帳本仍有 ${staleReal.length} 筆 real 倉位(目前模式 dry)`);
        }
      }
      return lines.join("\n");
    }
    case "balance": {
      const b = await fetchUsdtBalance(creds);
      const sign = b.unrealizedPnl >= 0 ? "+" : "";
      return `💰 USDT 權益 ${b.equity}｜可用 ${b.available}｜未實現 ${sign}${b.unrealizedPnl}`;
    }
    case "positions": {
      const [ps, ledger] = await Promise.all([
        fetchPositions(creds),
        readLiveLedger(cfg.ledgerPath),
      ]);
      if (ps.length === 0) return "目前沒有合約倉位";
      const auto = new Set(
        ledger.positions.filter((p) => p.status === "OPEN").map((p) => p.instId),
      );
      const lines = ps.map((p) => {
        const dir = p.pos > 0 ? "🟢 做多" : "🔴 做空";
        const pnl = `${p.upl >= 0 ? "+" : ""}${p.upl.toFixed(1)} USDT(${(p.uplRatio * 100).toFixed(1)}%)`;
        const tag = auto.has(p.instId) ? "自動" : "手動";
        return `${dir} ${p.instId} ×${Math.abs(p.pos)}(${p.lever}x,${tag})\n   均價 ${p.avgPx} ｜ 標記 ${p.markPx} ｜ 未實現 ${pnl}`;
      });
      return lines.join("\n");
    }
    case "report": {
      await deps.runReport();
      return "📊 已觸發 4h 紙上成績單推播";
    }
    case "help":
      return HELP_TEXT;
  }
}

interface SlackMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

// 讀 lastTs 之後的新訊息(排除 bot/系統訊息),依時間舊到新逐一處理;回傳新的 lastTs。
export async function pollOnce(deps: ControlDeps, lastTs: string): Promise<string> {
  const url =
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(deps.channel)}` +
    `&oldest=${encodeURIComponent(lastTs)}&inclusive=false&limit=20`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${deps.slackToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await resp.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
  if (!data.ok) throw new Error(`Slack 讀取失敗:${data.error ?? "unknown"}`);
  const msgs = (data.messages ?? [])
    .filter((m) => !m.bot_id && !m.subtype && m.text)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  let newLast = lastTs;
  for (const m of data.messages ?? []) {
    if (Number(m.ts) > Number(newLast)) newLast = m.ts;
  }
  for (const m of msgs) {
    const cmd = parseCommand(m.text ?? "");
    if (!cmd) continue; // 非指令文字直接忽略(頻道可能有人聊天)
    let reply: string;
    try {
      reply = await handleCommand(cmd, deps);
    } catch (e) {
      reply = `🚨 指令執行失敗:${(e as Error).message}`;
    }
    try {
      await deps.post(reply);
    } catch (e) {
      // 回覆失敗只記 log,不可讓 pollOnce 拋出(否則 lastTs 不會前進,下一輪重播同一指令)。
      console.error(`[控制迴圈] 回覆 Slack 失敗:${(e as Error).message}`);
    }
  }
  return newLast;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 常駐控制迴圈:每 intervalMs 輪詢一次;單輪錯誤只記 log,迴圈不退出。
// 起始 lastTs = 現在(不重播啟動前的歷史指令)。
export async function runControlLoop(deps: ControlDeps, intervalMs = 30_000): Promise<never> {
  let lastTs = (Date.now() / 1000).toFixed(6);
  while (true) {
    try {
      lastTs = await pollOnce(deps, lastTs);
    } catch (e) {
      console.error(`[控制迴圈] ${(e as Error).message}`);
    }
    await sleep(intervalMs);
  }
}
