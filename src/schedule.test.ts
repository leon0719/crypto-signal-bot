import { describe, expect, test } from "bun:test";
import { nextRunTime, shouldPushReport } from "./schedule.js";

const HOURS = [0, 4, 8, 12, 16, 20];

describe("nextRunTime", () => {
  test("非執行小時 → 前進到下一個執行小時的該分鐘", () => {
    // 06:01:30 → 下一個是 08:02:00
    const now = new Date("2026-07-01T06:01:30.000Z");
    expect(nextRunTime(now, HOURS, 2).toISOString()).toBe("2026-07-01T08:02:00.000Z");
  });

  test("剛過執行分鐘 → 跳到下一個執行小時", () => {
    // 08:02:30 已過 08:02 → 12:02:00
    const now = new Date("2026-07-01T08:02:30.000Z");
    expect(nextRunTime(now, HOURS, 2).toISOString()).toBe("2026-07-01T12:02:00.000Z");
  });

  test("執行小時但還沒到該分鐘 → 就是本小時的該分鐘", () => {
    // 08:01:00 → 08:02:00
    const now = new Date("2026-07-01T08:01:00.000Z");
    expect(nextRunTime(now, HOURS, 2).toISOString()).toBe("2026-07-01T08:02:00.000Z");
  });

  test("剛好等於執行時點 → 嚴格晚於,取下一個", () => {
    const now = new Date("2026-07-01T08:02:00.000Z");
    expect(nextRunTime(now, HOURS, 2).toISOString()).toBe("2026-07-01T12:02:00.000Z");
  });

  test("跨日:當日最後一個執行小時之後 → 隔日第一個", () => {
    // 20:30 → 隔日 00:02:00
    const now = new Date("2026-07-01T20:30:00.000Z");
    expect(nextRunTime(now, HOURS, 2).toISOString()).toBe("2026-07-02T00:02:00.000Z");
  });
});

describe("shouldPushReport:每天 UTC0 推成績單", () => {
  test("UTC 00 時段 → true(不分星期)", () => {
    expect(shouldPushReport(new Date("2026-07-16T00:05:00Z"))).toBe(true); // 週四
    expect(shouldPushReport(new Date("2026-07-20T00:02:00Z"))).toBe(true); // 週一
  });
  test("其他掃描時段 → false", () => {
    expect(shouldPushReport(new Date("2026-07-16T04:02:00Z"))).toBe(false);
    expect(shouldPushReport(new Date("2026-07-16T20:59:00Z"))).toBe(false);
  });
});
