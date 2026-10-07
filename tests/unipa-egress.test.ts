import { describe, expect, it, vi } from "vitest";
import {
  createPinnedWebhookFetch,
  publicIPv4,
} from "../src/unipa/pinned-egress";

const request = {
  method: "POST",
  redirect: "error",
  body: "{}",
  headers: {
    "Content-Type": "application/json",
    "webhook-id": "fixture-event",
  },
} as RequestInit;
const encoder = new TextEncoder();
function setup(
  response = "HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\n\r\n{}",
  addresses = ["8.8.8.8"],
) {
  const channel = {
    exchange: vi.fn(async () => encoder.encode(response)),
    close: vi.fn(async () => {}),
  };
  const dependencies = {
    resolveA: vi.fn(async () => addresses),
    openTls: vi.fn(async () => channel),
  };
  return {
    fetch: createPinnedWebhookFetch(["receiver.example.com"], dependencies),
    dependencies,
    channel,
  };
}
describe("pinned callback egress (no live DNS/socket)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.1",
    "198.19.0.1",
    "0177.0.0.1",
    "::1",
    "8.8.8.999",
  ])("rejects special or malformed address %s", (ip) => {
    expect(publicIPv4(ip)).toBe(false);
  });
  it("pins the resolved public address and preserves TLS/Host names", async () => {
    const fixture = setup();
    expect(
      (
        await fixture.fetch(
          "https://receiver.example.com/callback?fixture=1",
          request,
        )
      ).status,
    ).toBe(202);
    expect(fixture.dependencies.openTls).toHaveBeenCalledWith(
      "8.8.8.8",
      "receiver.example.com",
      expect.any(AbortSignal),
    );
    const wire = new TextDecoder().decode(
      fixture.channel.exchange.mock.calls[0]![0],
    );
    expect(wire).toContain(
      "POST /callback?fixture=1 HTTP/1.1\r\nHost: receiver.example.com",
    );
    expect(wire).toContain("Connection: close");
    expect(fixture.channel.close).toHaveBeenCalledOnce();
  });
  it("rejects mixed public/private answers before connecting", async () => {
    const fixture = setup(undefined, ["8.8.8.8", "127.0.0.1"]);
    await expect(
      fixture.fetch("https://receiver.example.com/", request),
    ).rejects.toThrow("EGRESS_ADDRESS_REJECTED");
    expect(fixture.dependencies.openTls).not.toHaveBeenCalled();
  });
  it("rejects unlisted hosts and secret-bearing unexpected headers before DNS", async () => {
    const fixture = setup();
    await expect(
      fixture.fetch("https://other.example.com/", request),
    ).rejects.toThrow("CALLBACK_INVALID");
    expect(fixture.dependencies.resolveA).not.toHaveBeenCalled();
    await expect(
      fixture.fetch("https://receiver.example.com/", {
        ...request,
        headers: { Cookie: "fixture-only" },
      }),
    ).rejects.toThrow("EGRESS_HEADER_REJECTED");
    expect(fixture.dependencies.openTls).not.toHaveBeenCalled();
  });
  it.each([
    "HTTP/1.1 302 Found\r\nLocation: https://other.example.com/\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nfixture",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n{}",
  ])("fails closed on redirects/ambiguous HTTP framing", async (wire) => {
    const fixture = setup(wire);
    await expect(
      fixture.fetch("https://receiver.example.com/", request),
    ).rejects.toThrow();
    expect(fixture.channel.close).toHaveBeenCalledOnce();
  });
  it("accepts bounded chunked challenge JSON", async () => {
    const fixture = setup(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    );
    expect(
      await (
        await fixture.fetch("https://receiver.example.com/", request)
      ).text(),
    ).toBe("{}");
  });
  it("honors abort before DNS", async () => {
    const fixture = setup(),
      abort = new AbortController();
    abort.abort();
    await expect(
      fixture.fetch("https://receiver.example.com/", {
        ...request,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(fixture.dependencies.resolveA).not.toHaveBeenCalled();
  });
});
