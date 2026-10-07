import {
  prepareSignedNoticeEvent,
  prepareSignedWebhook,
} from "./event-protocol";
import type { NoticeEvent } from "./events";

export interface WebhookDestination {
  id: string;
  url: string;
  secret: string;
  previousSecret?: string;
  rotationUntil?: number;
}
// Egress MUST pin a public resolved address per connection, preserve TLS hostname
// verification, reject private/local addresses and redirects. No global fetch fallback:
// global_fetch_strictly_public alone is not a DNS/SSRF guarantee.
export type VerifiedWebhookFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export function callbackHosts(raw: string | undefined): string[] | null {
  const hosts = (raw ?? "").split(",").map((host) => host.trim());
  if (
    !hosts.length ||
    hosts.length > 8 ||
    hosts.some(
      (host) =>
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(
          host,
        ),
    )
  )
    return null;
  return [...new Set(hosts)];
}

export function validateCallbackUrl(
  raw: string,
  allowedHosts: string[],
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CALLBACK_INVALID");
  }
  if (
    raw.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    !allowedHosts.includes(url.hostname) ||
    /^[\d.]+$/.test(url.hostname) ||
    !url.hostname.includes(".")
  )
    throw new Error("CALLBACK_INVALID");
  return url.toString();
}

export async function boundedResponseText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return output + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("RESPONSE_TOO_LARGE");
      }
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function equalChallenge(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

export class SubscriptionWebhookTransport {
  constructor(
    private readonly allowedHosts: string[],
    private readonly webhookFetch: VerifiedWebhookFetch,
  ) {}
  async verify(destination: WebhookDestination): Promise<void> {
    const url = validateCallbackUrl(destination.url, this.allowedHosts);
    const challenge = crypto.randomUUID();
    const body = JSON.stringify({ type: "verification", challenge });
    const signed = await prepareSignedWebhook(
      `verification_${crypto.randomUUID()}`,
      body,
      destination.id,
      destination.secret,
    );
    try {
      const response = await this.webhookFetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        ...signed,
      });
      const reply = JSON.parse(await boundedResponseText(response, 4096)) as {
        challenge?: unknown;
      };
      if (
        !response.ok ||
        typeof reply.challenge !== "string" ||
        !equalChallenge(reply.challenge, challenge)
      )
        throw new Error("Rejected challenge");
    } catch {
      throw new Error("CALLBACK_VERIFICATION_FAILED");
    }
  }
  async deliver(
    destination: WebhookDestination,
    event: NoticeEvent,
  ): Promise<{ status: number }> {
    const url = validateCallbackUrl(destination.url, this.allowedHosts);
    const now = Date.now();
    const signed = await prepareSignedNoticeEvent(
      event,
      destination.id,
      destination.secret,
      now,
    );
    if (destination.previousSecret && (destination.rotationUntil ?? 0) > now) {
      const old = await prepareSignedNoticeEvent(
        event,
        destination.id,
        destination.previousSecret,
        now,
      );
      signed.headers["webhook-signature"] +=
        ` ${old.headers["webhook-signature"]}`;
    }
    const response = await this.webhookFetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      ...signed,
    });
    await response.body?.cancel();
    return { status: response.status };
  }
}
