// 定時偵測進入點:掃描 → 篩有效機會 → 與上輪去重 → 只推新機會到 Slack。
import { diffNewOpportunities, filterOpportunities } from "../src/detect.js";
import { runScan } from "../src/scan.js";
import { buildSlackText, postMessage } from "../src/slack.js";
import { readActive, writeActive } from "../src/state.js";

const STATE_PATH = process.env.STATE_PATH ?? "./data/signal-state.json";

const rows = await runScan();
const opps = filterOpportunities(rows);
const prev = await readActive(STATE_PATH);
const { news, active } = diffNewOpportunities(opps, prev);
await writeActive(STATE_PATH, active);

console.log(
  `[${new Date().toISOString()}] 掃描完成:有效機會 ${opps.length}、新機會 ${news.length}`,
);

if (news.length > 0) {
  try {
    await postMessage(buildSlackText(news));
    console.log(
      `已推播 ${news.length} 則到 Slack:${news.map((o) => `${o.symbol}:${o.dir}`).join(", ")}`,
    );
  } catch (e) {
    console.error(`Slack 推播失敗:${(e as Error).message}`);
    process.exitCode = 1;
  }
}
