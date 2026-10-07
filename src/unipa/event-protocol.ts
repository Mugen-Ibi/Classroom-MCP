import { z } from "zod";
import { noticeEventSchema, type NoticeEvent } from "./events";

// Catalog preparation only; production does not advertise events until its complete
// authenticated subscription lifecycle, persistent storage and safe transport exist.
export const importantNoticeEventDefinition = {
  name: "unipa.important_notice_detected",
  description:
    "本人のUNIPA掲示一覧で新たに検出された未読の重大通知候補。件名等による一次判定であり、内容は未確認です。",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: z.toJSONSchema(noticeEventSchema.shape.data),
};

export function validWebhookSecret(secret: string): boolean {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  try {
    const raw = atob(secret.slice(6));
    return (
      raw.length >= 24 && raw.length <= 64 && btoa(raw) === secret.slice(6)
    );
  } catch {
    return false;
  }
}

// Produces bytes/headers for a mock or a future verified transport; does not send.
// Real callback URLs and subscription secrets must never be logged or returned by tools.
export async function prepareSignedNoticeEvent(
  event: NoticeEvent,
  subscriptionId: string,
  secret: string,
  signedAt = Date.now(),
): Promise<{ body: string; headers: Record<string, string> }> {
  const parsed = noticeEventSchema.safeParse(event);
  if (!parsed.success) throw new Error("INVALID_EVENT_DELIVERY");
  return prepareSignedWebhook(
    event.eventId,
    JSON.stringify(parsed.data),
    subscriptionId,
    secret,
    signedAt,
  );
}

export async function prepareSignedWebhook(
  eventId: string,
  body: string,
  subscriptionId: string,
  secret: string,
  signedAt = Date.now(),
): Promise<{ body: string; headers: Record<string, string> }> {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId) ||
    !Number.isFinite(signedAt) ||
    signedAt < 0 ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
  )
    throw new Error("INVALID_EVENT_DELIVERY");
  let keyBytes: Uint8Array;
  try {
    const raw = atob(secret.slice(6));
    keyBytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (
      keyBytes.length < 24 ||
      keyBytes.length > 64 ||
      btoa(raw) !== secret.slice(6)
    )
      throw new Error("Invalid key");
  } catch {
    throw new Error("INVALID_EVENT_DELIVERY");
  }
  if (new TextEncoder().encode(body).length > 256 * 1024)
    throw new Error("EVENT_PAYLOAD_TOO_LARGE");
  const timestamp = String(Math.floor(signedAt / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
    ),
  );
  const encoded = btoa(
    Array.from(signature, (byte) => String.fromCharCode(byte)).join(""),
  );
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${encoded}`,
      "X-MCP-Subscription-Id": subscriptionId,
    },
  };
}
