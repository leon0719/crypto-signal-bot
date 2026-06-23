// Cloudflare Worker 入口:接收 LINE webhook,分析後以 reply token 回覆。

import { handleText } from "./analyze.js";
import { replyText, verifySignature } from "./line.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康檢查 / 根路徑。
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

    const events = payload.events || [];
    // 逐一處理事件;回覆動作放到背景,確保 webhook 能即時回 200(LINE 要求快速回應)。
    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const replyToken = event.replyToken;
      const userText = event.message.text;
      ctx.waitUntil(
        handleText(userText)
          .then((reply) => replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, reply))
          .catch((err) =>
            replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, `❌ 發生錯誤:${err.message}`),
          ),
      );
    }

    return new Response("OK", { status: 200 });
  },
};
