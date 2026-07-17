// 實盤自動下單本機控制 CLI(不需 Slack 讀取權限;開關檔有跨行程鎖,與排程器並存安全)。
// 用法:bun scripts/live-ctl.ts <on|off|status|balance|positions|panic|report>
// 執行結果會同步推一份到 Slack 控制頻道留審計紀錄(僅發送,失敗不影響指令本身)。
import { type ControlCommand, type ControlDeps, handleCommand } from "../src/control.js";
import { liveConfigFromEnv } from "../src/live.js";
import { credsFromEnv } from "../src/okx.js";
import { nextRunTime } from "../src/schedule.js";
import { postMessage } from "../src/slack.js";
import { intervalMsOf } from "../src/strategies.js";

const USAGE = [
  "用法:bun scripts/live-ctl.ts <指令>",
  "  on         啟動自動下單",
  "  off        停止自動下單(既有倉交給交易所 TP/SL)",
  "  status     開關/模式/自動倉位/下次掃描",
  "  balance    USDT 權益/可用/未實現",
  "  positions  目前合約倉位(標註自動/手動)",
  "  panic      緊急平倉(停止+市價平所有自動倉)",
  "  report     立即推 4h 紙上成績單到 Slack",
].join("\n");

const CLI_MAP: Record<string, ControlCommand> = {
  on: "start",
  off: "stop",
  status: "status",
  balance: "balance",
  positions: "positions",
  panic: "panic",
  report: "report",
};

const arg = process.argv[2] ?? "";
const cmd = CLI_MAP[arg];
if (!cmd) {
  console.log(USAGE);
  process.exit(arg ? 1 : 0);
}

// panic 是不可逆的真金白銀操作,要求明確二次確認旗標。
if (cmd === "panic" && process.argv[3] !== "--yes") {
  console.error(
    "緊急平倉會市價平掉所有自動倉位。確認請加 --yes:bun scripts/live-ctl.ts panic --yes",
  );
  process.exit(1);
}

const controlChannel = process.env.SLACK_CONTROL_CHANNEL_ID;
const RUN_HOURS = Array.from({ length: 24 }, (_, h) => h);

const deps: ControlDeps = {
  cfg: liveConfigFromEnv(intervalMsOf("4h")),
  creds: credsFromEnv(),
  post: async (text) => {
    if (controlChannel) await postMessage(text, controlChannel);
  },
  runReport: async () => {
    const proc = Bun.spawn(["bun", "scripts/paper-report.ts", "4h"], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    await proc.exited;
  },
  nextScanText: () => nextRunTime(new Date(), RUN_HOURS, 2).toISOString(),
  slackToken: process.env.SLACK_BOT_TOKEN ?? "",
  channel: controlChannel ?? "",
};

const reply = await handleCommand(cmd, deps);
console.log(reply);

// 審計:結果同步推 Slack(標註來源是 CLI);失敗不影響指令已完成的效果。
if (controlChannel) {
  try {
    await postMessage(`💻 [CLI] ${reply}`, controlChannel);
  } catch (e) {
    console.error(`(Slack 審計通知失敗:${(e as Error).message})`);
  }
}
