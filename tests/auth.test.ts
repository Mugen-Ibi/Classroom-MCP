import { describe, expect, it, vi } from "vitest";
import { authHandler } from "../src/auth";
import type { Env } from "../src/types";

describe("Bounded consent form", () => {
  it("does not grant UNIPA when Secrets are enabled after the consent page was shown", async () => {
    let pending: { scope: string[] };
    let approvedScope: string[] = [];
    const oauth = {
      parseAuthRequest: vi.fn(async () => ({
        scope: ["classroom:read", "offline_access"],
      })),
      describeConsent: vi.fn(async () => ({
        clientName: "Synthetic client",
        redirectHost: "client.example",
        redirectIsLoopback: false,
      })),
      beginConsent: vi.fn(async (request) => {
        pending = { scope: [...request.scope] };
        return { handle: "synthetic-handle", headers: new Headers() };
      }),
      approveConsent: vi.fn(async (_request, _handle, options) => ({
        request: { scope: options?.scope ?? pending.scope },
        headers: new Headers(),
      })),
      beginUpstream: vi.fn(async (request) => {
        approvedScope = request.scope;
        return { state: "synthetic-state", headers: new Headers() };
      }),
    };
    const env = {
      PUBLIC_URL: "https://classroom.test",
      GOOGLE_CLIENT_ID: "synthetic-client",
      GOOGLE_CLIENT_SECRET: "synthetic-secret",
      OAUTH_PROVIDER: oauth,
    } as unknown as Env;
    const consent = await authHandler.fetch(
      new Request(`${env.PUBLIC_URL}/authorize`),
      env,
    );
    expect(await consent.text()).not.toContain("unipa:read");
    env.UNIPA_USER_ID = "synthetic-student";
    env.UNIPA_PASSWORD = "synthetic-password";
    const approved = await authHandler.fetch(
      new Request(`${env.PUBLIC_URL}/authorize`, {
        method: "POST",
        headers: {
          Origin: env.PUBLIC_URL,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          handle: "synthetic-handle",
          decision: "approve",
        }).toString(),
      }),
      env,
    );
    expect(approved.status).toBe(302);
    expect(approvedScope).toEqual(["classroom:read", "offline_access"]);
  });
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
