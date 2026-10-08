import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash } from "node:crypto";

const origin = "http://localhost:8787";
const verifier = "synthetic-fixture-verifier-at-least-43-characters-123456";
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        { type: "ESModule", path: "tests/refresh-rotation-entry.js" },
        {
          type: "ESModule",
          path: "node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
        },
      ],
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["global_fetch_strictly_public"],
      kvNamespaces: ["OAUTH_KV"],
    }),
  );
  await mf.ready;
});
afterAll(async () => mf?.dispose());
const control = async (path: string, body: object) => {
  const response = await mf.dispatchFetch(`${origin}/fixture/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(text);
  return JSON.parse(text);
};
const tokenRequest = (body: Record<string, string>) =>
  mf.dispatchFetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
async function issue() {
  const client = await control("create", {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const response = await tokenRequest({
    grant_type: "authorization_code",
    client_id: client.clientId,
    code: client.code,
    code_verifier: verifier,
    redirect_uri: "http://localhost:3000/callback",
  });
  expect(response.status).toBe(200);
  return { clientId: client.clientId as string, ...(await response.json()) };
}
const refresh = (
  client: { clientId: string },
  token: string,
  extra: Record<string, string> = {},
) =>
  tokenRequest({
    grant_type: "refresh_token",
    client_id: client.clientId,
    refresh_token: token,
    ...extra,
  });
const protectedAccess = (token: string) =>
  mf.dispatchFetch(`${origin}/mcp`, {
    headers: { Authorization: `Bearer ${token}` },
  });

it("returns the same rotation for simultaneous requests and valid repeated retries without another callback", async () => {
  const client = await issue();
  const before = await control("grant", { token: client.refresh_token });
  const responses = await Promise.all([
    refresh(client, client.refresh_token),
    refresh(client, client.refresh_token),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const first = await responses[0]!.json(),
    second = await responses[1]!.json();
  expect(second).toEqual(first);
  await control("advance", { milliseconds: 119_000 });
  const retried = await (await refresh(client, client.refresh_token)).json();
  expect(retried.refresh_token).toBe(first.refresh_token);
  expect(retried.access_token).toBe(first.access_token);
  expect(retried.expires_in).toBe(first.expires_in - 119);
  const saved = await control("grant", { token: first.refresh_token });
  expect(saved.refreshCalls - before.refreshCalls).toBe(1);
  expect(saved.grant.refreshTokenRotationHistory[0].expiresAt).toBe(
    Math.floor(before.now / 1000) + 120,
  );
  const serialized = JSON.stringify(saved.grant);
  expect(serialized).not.toContain(first.access_token);
  expect(serialized).not.toContain(first.refresh_token);
  expect(serialized).not.toContain(client.refresh_token);
  expect((await protectedAccess(first.access_token)).status).toBe(200);
  expect((await refresh(client, first.refresh_token)).status).toBe(200);
});

it.each([120_000, 25 * 3600_000])(
  "rejects known previous reuse after %i ms and revokes the grant, current refresh and access tokens",
  async (milliseconds) => {
    const client = await issue();
    const rotated = await (await refresh(client, client.refresh_token)).json();
    await control("advance", { milliseconds });
    const rejected = await refresh(client, client.refresh_token);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe("invalid_grant");
    expect(
      (await control("grant", { token: client.refresh_token })).grant,
    ).toBeNull();
    expect((await refresh(client, rotated.refresh_token)).status).toBe(400);
    expect((await protectedAccess(rotated.access_token)).status).toBe(401);
    expect((await refresh(client, client.refresh_token)).status).toBe(400);
  },
);

it("detects old generations after later rotations, while allowing recent earlier retries", async () => {
  const client = await issue();
  const r1 = await (await refresh(client, client.refresh_token)).json();
  const r2 = await (await refresh(client, r1.refresh_token)).json();
  const r0Retry = await (await refresh(client, client.refresh_token)).json();
  expect(r0Retry.refresh_token).toBe(r1.refresh_token);
  const r1Retry = await (await refresh(client, r1.refresh_token)).json();
  expect(r1Retry.refresh_token).toBe(r2.refresh_token);
  await control("advance", { milliseconds: 121_000 });
  expect((await refresh(client, client.refresh_token)).status).toBe(400);
  expect((await refresh(client, r2.refresh_token)).status).toBe(400);
});

it("does not revoke for forged tokens, malformed tokens, or another authenticated client", async () => {
  const client = await issue(),
    other = await issue();
  const rotated = await (await refresh(client, client.refresh_token)).json();
  await control("advance", { milliseconds: 121_000 });
  const parts = client.refresh_token.split(":");
  expect(
    (await refresh(client, `${parts[0]}:${parts[1]}:forged-fixture`)).status,
  ).toBe(400);
  expect((await refresh(client, "malformed-fixture")).status).toBe(400);
  expect((await refresh(other, client.refresh_token)).status).toBe(400);
  expect((await protectedAccess(rotated.access_token)).status).toBe(200);
  expect((await refresh(client, rotated.refresh_token)).status).toBe(200);
});

it("requires matching scope/resource on retries and preserves the current token on rejected input", async () => {
  const client = await issue();
  const rotated = await (
    await refresh(client, client.refresh_token, { scope: "fixture:read" })
  ).json();
  expect(
    (await refresh(client, client.refresh_token, { scope: "fixture:other" }))
      .status,
  ).toBe(400);
  expect(
    (
      await refresh(client, client.refresh_token, {
        resource: "http://foreign.test/mcp",
      })
    ).status,
  ).toBe(400);
  const replay = await refresh(client, client.refresh_token, {
    scope: "fixture:read",
  });
  expect(replay.status).toBe(200);
  expect((await replay.json()).refresh_token).toBe(rotated.refresh_token);
  expect((await refresh(client, rotated.refresh_token)).status).toBe(200);
});

it("retains authorization on a transient callback failure and succeeds on retry", async () => {
  const client = await issue();
  await control("fail-next", {});
  const failed = await refresh(client, client.refresh_token);
  expect((await failed.json()).error).toBe("temporarily_unavailable");
  expect((await refresh(client, client.refresh_token)).status).toBe(200);
});

it("fails closed for an unbounded legacy previous token but accepts a legacy current token", async () => {
  const client = await issue();
  const rotated = await (await refresh(client, client.refresh_token)).json();
  await control("grant", { token: client.refresh_token, legacy: true });
  expect((await refresh(client, rotated.refresh_token)).status).toBe(200);
  const another = await issue();
  const otherRotated = await (
    await refresh(another, another.refresh_token)
  ).json();
  await control("grant", { token: another.refresh_token, legacy: true });
  expect((await refresh(another, another.refresh_token)).status).toBe(400);
  expect((await refresh(another, otherRotated.refresh_token)).status).toBe(400);
});

it("bounds rapid rotations with a retryable error, and reconnects on the grant history limit", async () => {
  const client = await issue();
  let current = client.refresh_token;
  for (let i = 0; i < 16; i++) {
    const response = await refresh(client, current);
    expect(response.status).toBe(200);
    current = (await response.json()).refresh_token;
  }
  const throttled = await refresh(client, current);
  expect(throttled.status).toBe(429);
  expect((await throttled.json()).error).toBe("temporarily_unavailable");
  await control("advance", { milliseconds: 120_000 });
  expect((await refresh(client, current)).status).toBe(200);
  const exhausted = await issue();
  await control("grant", { token: exhausted.refresh_token, fullHistory: true });
  expect((await refresh(exhausted, exhausted.refresh_token)).status).toBe(400);
  expect(
    (await control("grant", { token: exhausted.refresh_token })).grant,
  ).toBeNull();
});

it("demonstrates the remaining KV stale-read race even with local serialization", async () => {
  const client = await issue();
  await control("grant", { token: client.refresh_token, staleReads: 2 });
  const first = await (await refresh(client, client.refresh_token)).json();
  const second = await (await refresh(client, client.refresh_token)).json();
  expect(second.refresh_token).not.toBe(first.refresh_token);
  // The second stale write replaced the first rotation. This is an explicit
  // limitation test, not a claim that local locks make KV transactional.
  expect((await refresh(client, first.refresh_token)).status).toBe(400);
  expect((await refresh(client, second.refresh_token)).status).toBe(200);
});
