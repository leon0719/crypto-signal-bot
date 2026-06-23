// LINE Messaging API:webhook 簽章驗證與回覆。

const REPLY_URL = "https://api.line.me/v2/bot/message/reply";

// 驗證 X-Line-Signature:以 channel secret 對 raw body 做 HMAC-SHA256,base64 後比對。
export async function verifySignature(channelSecret, rawBody, signature) {
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 用 reply token 回覆文字訊息(LINE 文字上限 5000 字)。
export async function replyText(accessToken, replyToken, text) {
  const res = await fetch(REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 5000) }],
    }),
  });
  if (!res.ok) {
    console.error(`LINE reply failed: ${res.status} ${await res.text()}`);
  }
}
