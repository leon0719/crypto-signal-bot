import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Opportunity } from "./detect.js";
import { defaultConfig } from "./signal.js";
import { buildSlackText, postMessage } from "./slack.js";

afterEach(() => mock.restore());

const link: Opportunity = {
  symbol: "LINKUSDT",
  dir: "SHORT",
  entry: 7.16,
  stop: 7.42,
  target: 6.77,
  atr: 0.13,
  score: -88,
  regime: "趨勢",
  adx: 36,
  htf1d: -86.9,
  oi: -1,
};

describe("buildSlackText", () => {
  test("含幣種、方向、進場/停損/目標與免責", () => {
    const text = buildSlackText([link]);
    expect(text).toContain("LINKUSDT");
    expect(text).toContain("做空");
    expect(text).toContain("7.16");
    expect(text).toContain("7.42");
    expect(text).toContain("6.77");
    // 倍數標籤跟著 defaultConfig 走,不寫死
    expect(text).toContain(`${defaultConfig().stopATR}×ATR`);
    expect(text).toContain("非投資建議");
    expect(text).toContain("1 個"); // 摘要數量
  });
});

describe("postMessage", () => {
  test("POST 到 chat.postMessage,body 帶 env 頻道與 text", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    const captured: { url: string; body: string } = { url: "", body: "" };
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = String(init.body);
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await postMessage("哈囉");

    expect(captured.url).toContain("chat.postMessage");
    const body = JSON.parse(captured.body);
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("哈囉");
  });

  test("Slack 回 ok:false → 拋錯", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" })),
    ) as unknown as typeof fetch;

    expect(postMessage("x")).rejects.toThrow("channel_not_found");
  });

  test("帶 channelId → body 用指定頻道,不用 env 預設", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    const captured = { body: "" };
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      captured.body = String(init.body);
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await postMessage("哈囉", "C999");

    expect(JSON.parse(captured.body).channel).toBe("C999");
  });
});
