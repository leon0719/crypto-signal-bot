// 定時偵測進入點:掃描 → 篩有效機會 → 與上輪去重 → 只推新機會到 Slack。
import { diffNewOpportunities, filterOpportunities, keyOf } from "../src/detect.js";
import { runScan } from "../src/scan.js";
import { buildSlackText, postMessage } from "../src/slack.js";
import { readActive, writeActive } from "../src/state.js";

const STATE_PATH = process.env.STATE_PATH ?? "./data/signal-state.json";

const rows = await runScan();

// 0 筆通常代表整輪 fetch 全數失敗/限流:不要重算去重狀態(否則會抹掉 active,
// 恢復後把仍有效的機會全部當新機會重推),直接結束並警示。
if (rows.length === 0) {
  console.warn(
    `[${new Date().toISOString()}] 掃描 0 筆(可能整輪 fetch 失敗或限流)— 跳過本輪,不更新去重狀態`,
  );
  process.exitCode = 1;
} else {
  const opps = filterOpportunities(rows);
  const prev = await readActive(STATE_PATH);
  const { news, active } = diffNewOpportunities(opps, prev);

  console.log(
    `[${new Date().toISOString()}] 掃描完成:有效機會 ${opps.length}、新機會 ${news.length}`,
  );

  // 預設把本輪全部有效機會寫入狀態;若推播失敗,把新機會的 key 撤回,下輪可補推。
  let committed = active;
  if (news.length > 0) {
    try {
      await postMessage(buildSlackText(news));
      console.log(
        `已推播 ${news.length} 則到 Slack:${news.map((o) => `${o.symbol}:${o.dir}`).join(", ")}`,
      );
    } catch (e) {
      const newsKeys = new Set(news.map((o) => keyOf(o)));
      committed = active.filter((k) => !newsKeys.has(k));
      console.error(`Slack 推播失敗:${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  await writeActive(STATE_PATH, committed);
}
