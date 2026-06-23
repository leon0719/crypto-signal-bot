// Cloudflare Worker 入口:接收 LINE webhook,分析後以 reply token 回覆。

import { handleText } from "./analyze.js";
import { replyMessages, showLoading, textMessage, verifySignature } from "./line.js";
import type { Env } from "./types.js";

interface LineEvent {
  type: string;
  replyToken?: string;
  message?: { type: string; text: string };
  source?: { userId?: string };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("crypto-signal-bot OK", { status: 200 });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");
    if (!(await verifySignature(env.LINE_CHANNEL_SECRET, rawBody, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: { events?: LineEvent[] };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    for (const event of payload.events ?? []) {
      if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) continue;
      const replyToken = event.replyToken;
      const userText = event.message.text;
      const userId = event.source?.userId;

      // 先顯示「輸入中…」,分析放背景,確保 webhook 即時回 200。
      if (userId) ctx.waitUntil(showLoading(env.LINE_CHANNEL_ACCESS_TOKEN, userId));
      ctx.waitUntil(
        handleText(userText)
          .then((messages) => replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, messages))
          .catch((err: unknown) =>
            replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
              textMessage(`❌ 發生錯誤:${err instanceof Error ? err.message : String(err)}`),
            ]),
          ),
      );
    }

    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
