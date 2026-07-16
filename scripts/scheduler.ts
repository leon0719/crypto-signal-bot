// 常駐排程器:對齊 4h 收棒後 2 分(UTC)週期性執行 detect。
// 純 bun、零外部相依,取代 supercronic(其在本機 colima 容器有 fork/exec 相容問題)。
// 每次觸發以子行程跑 scripts/detect.ts,子行程失敗不會拖垮排程器。
// 可用環境變數 SCAN_EVERY_SECONDS 覆寫為「每 N 秒」模式(測試用)。
import { nextRunTime, shouldPushReport } from "../src/schedule.js";

const RUN_HOURS = [0, 4, 8, 12, 16, 20];
const RUN_MINUTE = 2;
const everySeconds = Number(process.env.SCAN_EVERY_SECONDS ?? 0);

if (everySeconds > 0) {
  console.log(`[排程器啟動] 測試模式:每 ${everySeconds} 秒執行一次`);
} else {
  console.log(`[排程器啟動] 每 4h 收棒後 ${RUN_MINUTE} 分(UTC 時 ${RUN_HOURS.join("/")})執行掃描`);
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

  console.log(`[${new Date().toISOString()}] 觸發掃描…`);
  const proc = Bun.spawn(["bun", "scripts/detect.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await proc.exited;

  // 每天 UTC 00 點那輪掃描後,自動推一張紙上交易成績單(日報)
  const d = new Date();
  if (everySeconds === 0 && shouldPushReport(d)) {
    console.log(`[${d.toISOString()}] 推播紙上交易日報…`);
    const rep = Bun.spawn(["bun", "scripts/paper-report.ts"], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    await rep.exited;
  }
}
