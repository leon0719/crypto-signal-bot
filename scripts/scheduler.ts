// 常駐排程器:每小時整點後 2 分(UTC)醒來,依 isStrategyDue 執行輪到的策略
// (1h 每小時、4h 逢 UTC 0/4/8/12/16/20)。每策略以子行程跑 detect,互不拖垮。
// 每天 UTC0 那輪後,各策略成績單推各自的 Slack 頻道。
// 可用環境變數 SCAN_EVERY_SECONDS 覆寫為「每 N 秒全策略執行」模式(測試用)。
import { isStrategyDue, nextRunTime, shouldPushReport } from "../src/schedule.js";
import { STRATEGIES } from "../src/strategies.js";

const RUN_HOURS = Array.from({ length: 24 }, (_, h) => h);
const RUN_MINUTE = 2;
const everySeconds = Number(process.env.SCAN_EVERY_SECONDS ?? 0);

if (everySeconds > 0) {
  console.log(`[排程器啟動] 測試模式:每 ${everySeconds} 秒執行全部策略`);
} else {
  const names = STRATEGIES.map((s) => `${s.name}(每 ${s.interval})`).join("、");
  console.log(`[排程器啟動] 每小時整點後 ${RUN_MINUTE} 分(UTC)檢查:${names}`);
}

async function runScript(args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await proc.exited;
}

while (true) {
  let waitMs: number;
  let label: string;
  if (everySeconds > 0) {
    waitMs = everySeconds * 1000;
    label = `${everySeconds} 秒後`;
  } else {
    const now = new Date();
    const next = nextRunTime(now, RUN_HOURS, RUN_MINUTE);
    waitMs = next.getTime() - now.getTime();
    label = `${next.toISOString()}(約 ${Math.round(waitMs / 60000)} 分後)`;
  }
  console.log(`下次掃描:${label}`);
  await Bun.sleep(waitMs);

  const now = new Date();
  for (const s of STRATEGIES) {
    if (everySeconds === 0 && !isStrategyDue(s.interval, now)) continue;
    console.log(`[${new Date().toISOString()}] 觸發掃描(${s.name})…`);
    await runScript(["scripts/detect.ts", s.name]);
  }

  // 每天 UTC 00 點那輪掃描後,各策略成績單推各自頻道(日報)
  if (everySeconds === 0 && shouldPushReport(now)) {
    for (const s of STRATEGIES) {
      console.log(`[${new Date().toISOString()}] 推播紙上交易日報(${s.name})…`);
      await runScript(["scripts/paper-report.ts", s.name]);
    }
  }
}
