import { describe, expect, test } from "bun:test";
import { STRATEGIES, intervalMsOf, strategyByName } from "./strategies.js";

describe("STRATEGIES", () => {
  test("name/路徑/頻道環境變數皆不重複", () => {
    const uniq = (xs: string[]) => new Set(xs).size === xs.length;
    expect(uniq(STRATEGIES.map((s) => s.name))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.statePath))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.ledgerPath))).toBe(true);
    expect(uniq(STRATEGIES.map((s) => s.channelEnv))).toBe(true);
  });

  test("只有 4h 推進場訊號;1h 靜音記帳", () => {
    expect(STRATEGIES.filter((s) => s.pushSignals).map((s) => s.name)).toEqual(["4h"]);
  });

  test("1h 策略的 HTF 是 4h、頻道環境變數是 SLACK_CHANNEL_ID_1H", () => {
    const s = strategyByName("1h");
    expect(s.htf).toBe("4h");
    expect(s.channelEnv).toBe("SLACK_CHANNEL_ID_1H");
  });
});

describe("strategyByName", () => {
  test("未知名稱拋錯並列出可用策略", () => {
    expect(() => strategyByName("2h")).toThrow("未知策略");
  });
});

describe("intervalMsOf", () => {
  test("1h/4h 換算毫秒", () => {
    expect(intervalMsOf("1h")).toBe(3_600_000);
    expect(intervalMsOf("4h")).toBe(14_400_000);
  });
  test("不支援的單位拋錯", () => {
    expect(() => intervalMsOf("1x")).toThrow("不支援");
  });
});
