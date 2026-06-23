// Cloudflare Worker 入口:接收 LINE webhook,分析後以 reply token 回覆。

import { handleText } from "./analyze.js";
import { replyMessages, textMessage, verifySignature } from "./line.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("crypto-signal-bot OK", { status: 200 });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");
    const valid = await verifySignature(env.LINE_CHANNEL_SECRET, rawBody, signature);
    if (!valid) return new Response("Invalid signature", { status: 401 });

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    for (const event of payload.events || []) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const replyToken = event.replyToken;
      const userText = event.message.text;
      // 回覆放背景,確保 webhook 即時回 200(LINE 要求快速回應)。
      ctx.waitUntil(
        handleText(userText)
          .then((messages) => replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, messages))
          .catch((err) =>
            replyMessages(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
              textMessage(`❌ 發生錯誤:${err.message}`),
            ]),
          ),
      );
    }

    return new Response("OK", { status: 200 });
  },
};
