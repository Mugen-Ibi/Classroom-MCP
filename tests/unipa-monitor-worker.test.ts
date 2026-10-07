import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { s256 } from "../src/google";

const origin = "http://127.0.0.1:8787";
const verifier = "fixture-verifier-at-least-forty-three-characters-123456";
let mf: Miniflare;
let token: string;
let grantId: string;
const cookies = new Map<string, string>();
const remember = (response: Response) => {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]!,
      index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
};
async function send(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Host", new URL(origin).host);
  return (await mf.getWorker("monitor")).fetch(`${origin}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
}
async function rpc(method: string, params: object = {}) {
  const response = await send("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  const reply = response.headers
    .get("Content-Type")
    ?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      )
    : JSON.parse(text);
  return { status: response.status, ...reply };
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "monitor",
          modules: [
            { type: "ESModule", path: "tests/monitor-entry.js" },
            { type: "ESModule", path: "tests/worker-entry.js" },
            { type: "ESModule", path: "dist/index.js" },
          ],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV", "UNIPA_SNAPSHOTS"],
          durableObjects: { UNIPA_MONITOR: "FixtureMonitor" },
          serviceBindings: { UNIPA_WEBHOOK_EGRESS: "monitor-mock" },
          outboundService: "monitor-mock",
          bindings: {
            PUBLIC_URL: origin,
            GOOGLE_CLIENT_ID: "test-client",
            GOOGLE_CLIENT_SECRET: "test-secret",
            ALLOWED_EMAILS: "student@example.com",
            UNIPA_USER_ID: "synthetic-student-id",
            UNIPA_PASSWORD: "synthetic-password",
            UNIPA_MONITOR_ENABLED: "true",
            UNIPA_BODY_ENABLED: "true",
            UNIPA_MONITOR_ALLOW_READ_STATE_CHANGE: "true",
            UNIPA_EVENT_CALLBACK_HOSTS: "receiver.example.com",
          },
        },
        {
          name: "monitor-mock",
          modules: [
            { type: "ESModule", path: "tests/monitor-mock.js" },
            { type: "ESModule", path: "tests/google-mock.js" },
            { type: "ESModule", path: "tests/unipa-mock.js" },
            { type: "ESModule", path: "tests/unipa-fixtures.js" },
          ],
          compatibilityDate: "2026-10-01",
        },
      ],
    }),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

it("requires fresh OAuth consent, persists a subscription, acquires a fixture body, and sends a signed event through the real Durable Object", async () => {
  expect((await send("/mcp", { method: "POST" })).status).toBe(401);
  const registered = await send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Monitor fixture",
      redirect_uris: ["http://localhost:3000/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = (await registered.json()).client_id;
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://localhost:3000/callback",
    response_type: "code",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    scope: "classroom:read offline_access",
  });
  const consent = await send(`/authorize?${query}`);
  remember(consent as unknown as Response);
  const consentBody = await consent.text();
  expect(consentBody).toContain("unipa:monitor");
  expect(consentBody).toContain("07:00・12:00・17:00");
  const handle = consentBody.match(/name="handle" value="([^"]+)"/)![1]!;
  const approval = await send("/authorize", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  expect(approval.status).toBe(302);
  remember(approval as unknown as Response);
  const google = new URL(approval.headers.get("Location")!);
  const callback = await send(
    `/callback?state=${google.searchParams.get("state")}&code=google-code`,
    {
      headers: {
        Cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
    },
  );
  expect(callback.status).toBe(302);
  const code = new URL(callback.headers.get("Location")!).searchParams.get(
    "code",
  )!;
  const exchange = await send("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "http://localhost:3000/callback",
      resource: `${origin}/mcp`,
    }).toString(),
  });
  expect(exchange.status).toBe(200);
  const issued = await exchange.json();
  expect(issued.scope).toContain("unipa:monitor");
  token = issued.access_token;
  expect((await rpc("server/discover")).result.capabilities.events).toEqual({});
  expect((await rpc("events/list")).result.events).toHaveLength(1);
  // SDK tool dispatch remains compatible with the SDK's existing protocol version.
  const toolCall = async (name: string, argumentsValue: object = {}) => {
    const response = await send("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name,
          arguments: argumentsValue,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const result = JSON.parse(
      text.startsWith("event:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : text,
    ).result;
    expect(result.isError, result.content[0].text).not.toBe(true);
    return JSON.parse(result.content[0].text);
  };
  const subscribed = await rpc("events/subscribe", {
    name: "unipa.important_notice_detected",
    arguments: {},
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/callback",
      secret: `whsec_${Buffer.from("fixture-only-public-key-material!").toString("base64")}`,
    },
    cursor: null,
  });
  const verificationTrace = await (
    await (
      await mf.getWorker("monitor-mock")
    ).fetch(`${origin}/__trace_fixture`)
  ).json();
  expect(subscribed.error, JSON.stringify(verificationTrace)).toBeUndefined();
  expect(subscribed.result.id).toMatch(/^[a-f0-9]{64}$/);
  const namespace = await mf.getDurableObjectNamespace(
    "UNIPA_MONITOR",
    "monitor",
  );
  const stub = namespace.get(namespace.idFromName("single-owner"));
  const firstPoll = await (
    await stub.fetch("https://monitor.internal/poll", {
      method: "POST",
      body: "{}",
    })
  ).json();
  expect(firstPoll.error).toBeUndefined();
  const baseline = await toolCall("unipa_list_announcements", { limit: 20 });
  expect(baseline.totalCount).toBe(2);
  const mock = await mf.getWorker("monitor-mock");
  let trace = await (await mock.fetch(`${origin}/__trace_fixture`)).json();
  expect(trace.events).toHaveLength(0);
  expect(trace.trace).toHaveLength(3);
  await mock.fetch(`${origin}/__next_fixture`);
  await mock.fetch(`${origin}/__fail_callback_fixture`);
  await stub.fetch("https://monitor.internal/__advance_fixture", {
    method: "POST",
  });
  const refreshed = await send("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: issued.refresh_token,
      resource: origin + "/mcp",
    }).toString(),
  });
  expect(refreshed.status).toBe(200);
  token = (await refreshed.json()).access_token;
  const poll = await stub.fetch("https://monitor.internal/poll", {
    method: "POST",
    body: "{}",
  });
  const pollResult = await poll.json();
  expect(pollResult.error).toBeUndefined();
  expect(pollResult.result.status).toBe("ok");
  trace = await (await mock.fetch(`${origin}/__trace_fixture`)).json();
  expect(trace.events).toHaveLength(1);
  expect(trace.trace).toHaveLength(7);
  expect(trace.events[0].data.title).toBe("明日の休講・教室変更");
  expect(trace.events[0].data).not.toHaveProperty("body");
  const body = await toolCall("unipa_read_cached_important_notice", {
    eventId: trace.events[0].eventId,
  });
  expect(body.result.status).toBe("retrieved");
  expect(body.result.body.text).toContain("合成された重要通知");
  await stub.fetch("https://monitor.internal/poll", {
    method: "POST",
    body: "{}",
  });
  const repeated = await (await mock.fetch(`${origin}/__trace_fixture`)).json();
  expect(repeated.events).toHaveLength(1);
  expect(repeated.trace).toHaveLength(7);
  await mock.fetch(`${origin}/__accept_callback_fixture`);
  await stub.fetch("https://monitor.internal/__advance_retry_fixture", {
    method: "POST",
  });
  const alarm = await (
    await stub.fetch("https://monitor.internal/__alarm_fixture", {
      method: "POST",
    })
  ).json();
  expect(alarm.before).toBeGreaterThan(Date.parse(trace.events[0].timestamp));
  expect(alarm.before).toBeLessThanOrEqual(alarm.now);
  expect(alarm.after).toBeGreaterThan(alarm.now + 3600_000);
  const retried = await (await mock.fetch(`${origin}/__trace_fixture`)).json();
  expect(retried.events).toHaveLength(2);
  expect(retried.events[1].eventId).toBe(retried.events[0].eventId);
  expect(retried.events[1].data.bodyReference.status).toBe("available");
  expect(retried.trace).toHaveLength(7); // Delivery-only alarm makes zero UNIPA requests.
  const unsubscribed = await rpc("events/unsubscribe", {
    name: "unipa.important_notice_detected",
    arguments: {},
    delivery: { mode: "webhook", url: "https://receiver.example.com/callback" },
  });
  expect(unsubscribed.result).toEqual({});
  const state = await toolCall("unipa_connection_status");
  expect(state.activeSubscriptions).toBe(0);
  // Revoke only fixture grants; cached access tokens must not preserve monitor access.
  const kv = await mf.getKVNamespace("OAUTH_KV", "monitor");
  const keys = await kv.list();
  const grantKey = keys.keys.find((item) => item.name.startsWith("grant:"));
  expect(grantKey).toBeDefined();
  grantId = grantKey!.name;
  await kv.delete(grantId);
  const revoked = await rpc("events/list");
  expect(revoked.error ?? revoked.status).toBeTruthy();
  expect(revoked.result).toBeUndefined();
}, 60_000);
