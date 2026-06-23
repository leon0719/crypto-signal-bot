import { describe, expect, test } from "bun:test";
import { verifySignature } from "./line.js";

export async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

describe("verifySignature", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({ events: [], destination: "U123" });

  test("正確簽章通過", async () => {
    expect(await verifySignature(secret, body, await sign(secret, body))).toBe(true);
  });

  test("錯誤 secret 不通過", async () => {
    expect(await verifySignature(secret, body, await sign("wrong", body))).toBe(false);
  });

  test("缺簽章不通過", async () => {
    expect(await verifySignature(secret, body, null)).toBe(false);
  });
});
