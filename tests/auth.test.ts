import { describe, expect, it, vi } from "vitest";
import { authHandler } from "../src/auth";
import type { Env } from "../src/types";

describe("Bounded consent form", () => {
  it("rejects an oversized chunked body while reading and cancels the stream", async () => {
    const approveConsent = vi.fn();
    const cancelled = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(4096).fill(97));
      },
      cancel: cancelled,
    });
    const request = new Request("https://classroom.test/authorize", {
      method: "POST",
      headers: {
        Origin: "https://classroom.test",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await authHandler.fetch(request, {
      PUBLIC_URL: "https://classroom.test",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      OAUTH_PROVIDER: { approveConsent },
    } as unknown as Env);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid consent form");
    expect(cancelled).toHaveBeenCalledOnce();
    // Node may prefetch one chunk; the unbounded source is never fully consumed.
    expect(chunks).toBeLessThanOrEqual(4);
    expect(approveConsent).not.toHaveBeenCalled();
  });
});
