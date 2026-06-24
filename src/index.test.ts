import { afterEach, describe, expect, mock, test } from "bun:test";
import worker from "./index.js";
import { sign } from "./line.test.js";
import type { Env } from "./types.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const env: Env = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: "token" };

// 收集背景 promise 的 ExecutionContext。
function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(tasks),
  };
}

function fakeCandles(): string[][] {
  const rows: string[][] = [];
  let price = 100;
  for (let i = 0; i < 300; i++) {
    price += 0.5;
    const vol = i >= 298 ? "5000" : "1000"; // 末根放量,通過成交量過濾
    rows.push([String(1_700_000_000_000 + i * 3_600_000), "100", "101", "99", String(price), vol]);
  }
  return rows.reverse();
}

afterEach(() => mock.restore());

function post(body: string, signature: string): Request {
  return new Request("https://x/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  });
}

describe("worker.fetch", () => {
  test("GET 健康檢查", async () => {
    const res = await worker.fetch(new Request("https://x/"), env, makeCtx().ctx);
    expect(res.status).toBe(200);
  });

  test("簽章錯誤 → 401", async () => {
    const res = await worker.fetch(post('{"events":[]}', "bad"), env, makeCtx().ctx);
    expect(res.status).toBe(401);
  });

  test("有效訊息 → 200 且呼叫 LINE reply", async () => {
    const replies: string[] = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (url.includes("/market/candles"))
        return new Response(JSON.stringify({ code: "0", data: fakeCandles() }));
      if (url.includes("/funding-rate"))
        return new Response(JSON.stringify({ code: "0", data: [{ fundingRate: "0.0001" }] }));
      if (url.includes("/message/reply")) {
        replies.push(String(init?.body));
        return new Response("{}");
      }
      if (url.includes("/chat/loading/start")) return new Response("{}");
      return new Response("{}");
    }) as unknown as typeof fetch;

    const body = JSON.stringify({
      events: [
        {
          type: "message",
          replyToken: "rt1",
          message: { type: "text", text: "btc" },
          source: { userId: "U1" },
        },
      ],
    });
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(post(body, await sign(SECRET, body)), env, ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("BTCUSDT");
  });
});
