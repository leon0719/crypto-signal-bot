import { describe, expect, test } from "bun:test";
import { calendarQuarters } from "./backtest-harness.js";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("calendarQuarters", () => {
  test("切出涵蓋區間的完整季度,邊界不重疊不遺漏", () => {
    const qs = calendarQuarters(
      Date.parse("2021-02-15T00:00:00Z"),
      Date.parse("2021-09-01T00:00:00Z"),
    );
    expect(qs.map((q) => q.label)).toEqual(["2021Q1", "2021Q2", "2021Q3"]);
    expect(iso(qs[0].from)).toBe("2021-01-01");
    expect(iso(qs[1].from)).toBe("2021-04-01");
    // 前一季的 to 等於下一季的 from(半開區間 [from, to),不重疊)
    expect(qs[0].to).toBe(qs[1].from);
    expect(qs[2].to).toBe(Date.parse("2021-10-01T00:00:00Z"));
  });

  test("起訖落在同一季 → 只回一季", () => {
    const qs = calendarQuarters(
      Date.parse("2023-05-02T00:00:00Z"),
      Date.parse("2023-05-30T00:00:00Z"),
    );
    expect(qs.map((q) => q.label)).toEqual(["2023Q2"]);
  });

  test("跨年正確遞進", () => {
    const qs = calendarQuarters(
      Date.parse("2022-11-10T00:00:00Z"),
      Date.parse("2023-02-10T00:00:00Z"),
    );
    expect(qs.map((q) => q.label)).toEqual(["2022Q4", "2023Q1"]);
  });

  test("from 晚於 to → 回空陣列,不無窮迴圈", () => {
    expect(
      calendarQuarters(Date.parse("2023-05-01T00:00:00Z"), Date.parse("2023-01-01T00:00:00Z")),
    ).toEqual([]);
  });
});
