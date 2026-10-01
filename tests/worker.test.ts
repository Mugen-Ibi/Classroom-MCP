import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { s256 } from "../src/google";

const origin = "http://127.0.0.1:8787";
let mf: Miniflare;
let clientId: string;
let mcpToken: string;
let refreshToken: string;
const verifier =
  "this-is-a-test-verifier-with-at-least-forty-three-characters-1234";
const cookies = new Map<string, string>();
const remember = (response: Response) => {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]!;
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
};
const cookieHeader = () =>
  [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
const rpc = async (response: Response) => {
  const body = await response.text();
  if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data!.slice(6));
  }
  return JSON.parse(body);
};
const send = async (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Host", new URL(origin).host);
  return (await mf.getWorker("classroom")).fetch(`${origin}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
};

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "classroom",
          modules: true,
          scriptPath: "dist/index.js",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: {
            PUBLIC_URL: origin,
            GOOGLE_CLIENT_ID: "test-client",
            GOOGLE_CLIENT_SECRET: "test-secret",
          },
          outboundService: "google-mock",
        },
        {
          name: "google-mock",
          modules: true,
          scriptPath: "tests/google-mock.js",
          compatibilityDate: "2026-10-01",
        },
        {
          name: "unconfigured",
          modules: true,
          scriptPath: "dist/index.js",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: { PUBLIC_URL: origin },
        },
      ],
    }),
  );
  await mf.ready;
});
afterAll(async () => mf?.dispose());

describe("Worker OAuth and MCP in workerd", () => {
  it("publishes discovery, challenges unauthenticated MCP, and rejects a foreign host", async () => {
    expect((await send("/health")).status).toBe(200);
    const metadata = await (
      await send("/.well-known/oauth-authorization-server")
    ).json();
    expect(metadata.scopes_supported).toContain("classroom:read");
    expect(metadata.scopes_supported).toContain("offline_access");
    const unauthorized = await send("/mcp", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata",
    );
    expect((await mf.dispatchFetch("https://foreign.test/health")).status).toBe(
      403,
    );
    const unconfigured = await mf.getWorker("unconfigured");
    expect((await unconfigured.fetch(`${origin}/health`)).status).toBe(503);
    expect((await unconfigured.fetch(`${origin}/authorize`)).status).toBe(503);
  });

  it("registers a client and binds upstream consent to the approving browser", async () => {
    const registered = await send("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test MCP Client",
        redirect_uris: ["http://localhost:3000/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(registered.status).toBe(201);
    clientId = (await registered.json()).client_id;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      code_challenge: await s256(verifier),
      code_challenge_method: "S256",
      resource: `${origin}/mcp`,
      scope: "classroom:read offline_access",
      state: "client-state",
    });
    const consent = await send(`/authorize?${params}`);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("X-Frame-Options")).toBe("DENY");
    expect(consent.headers.get("Referrer-Policy")).toBe("origin");
    remember(consent as unknown as Response);
    const handle = (await consent.text()).match(
      /name="handle" value="([^"]+)"/,
    )![1]!;
    const form = new URLSearchParams({
      handle,
      decision: "approve",
    }).toString();
    // A consent cookie must not make missing, opaque, or foreign origins valid.
    for (const requestOrigin of [undefined, "null", "https://evil.test"]) {
      const headers = new Headers({
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(),
      });
      if (requestOrigin) headers.set("Origin", requestOrigin);
      const rejected = await send("/authorize", {
        method: "POST",
        headers,
        body: form,
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.text()).toMatch(/invalid origin/i);
    }
    const noCookie = await send("/authorize", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(noCookie.status, await noCookie.clone().text()).toBe(400);
    const approved = await send("/authorize", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(),
      },
      body: form,
    });
    expect(approved.status).toBe(302);
    expect(approved.headers.get("Referrer-Policy")).toBe("no-referrer");
    remember(approved as unknown as Response);
    const googleUrl = new URL(approved.headers.get("Location")!);
    expect(googleUrl.hostname).toBe("accounts.google.com");
    const callback = `/callback?state=${googleUrl.searchParams.get("state")}&code=google-code`;
    expect((await send(callback)).status).toBe(400);
    const completed = await send(callback, {
      headers: { Cookie: cookieHeader() },
    });
    expect(completed.status).toBe(302);
    const redirect = new URL(completed.headers.get("Location")!);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(
      (await send(callback, { headers: { Cookie: cookieHeader() } })).status,
    ).toBe(400);
    const token = await send("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: "http://localhost:3000/callback",
        resource: `${origin}/mcp`,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const issued = await token.json();
    mcpToken = issued.access_token;
    refreshToken = issued.refresh_token;
    expect(issued.expires_in).toBeLessThan(3600);
    expect(JSON.stringify(issued)).not.toContain("google-refresh");
  });

  it("lists five read-only tools and reads Classroom through an authenticated MCP call", async () => {
    const headers = {
      Authorization: `Bearer ${mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    };
    const initialized = await send("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    const info = (await rpc(initialized as unknown as Response)).result
      .serverInfo;
    expect(info.icons[0]).toEqual({
      src: `${origin}/icon-128.png`,
      mimeType: "image/png",
      sizes: ["128x128"],
    });
    const listed = await send("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const list = await rpc(listed as unknown as Response);
    expect(list.result.tools).toHaveLength(5);
    expect(
      list.result.tools.every(
        (tool: { annotations: { readOnlyHint: boolean } }) =>
          tool.annotations.readOnlyHint,
      ),
    ).toBe(true);
    const read = await send("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_courses", arguments: {} },
      }),
    });
    const result = await rpc(read as unknown as Response);
    expect(JSON.parse(result.result.content[0].text).courses[0].name).toBe(
      "Math",
    );
    expect(JSON.stringify(result)).not.toContain("google-access");
    const invalidInput = await send("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_assignment",
          arguments: { courseId: "..", assignmentId: "a" },
        },
      }),
    });
    const invalidResult = await rpc(invalidInput as unknown as Response);
    expect(Boolean(invalidResult.error || invalidResult.result?.isError)).toBe(
      true,
    );
    expect(
      (
        await send("/mcp", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("renews MCP access by refreshing the user's Google grant", async () => {
    const wrongAudience = await send("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: "https://other.example/mcp",
      }).toString(),
    });
    expect(wrongAudience.status).toBe(400);
    const refreshed = await send("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: `${origin}/mcp`,
      }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const token = await refreshed.json();
    expect(token.access_token).not.toBe(mcpToken);
    expect(token.refresh_token).not.toBe(refreshToken);
    expect(JSON.stringify(token)).not.toContain("google-refresh");
  });

  it("recovers a transient Classroom 503 during an authenticated MCP call", async () => {
    const response = await send("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "list_courses",
          arguments: { pageToken: "transient-fixture" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = await rpc(response as unknown as Response);
    expect(result.result.isError).not.toBe(true);
    expect(JSON.parse(result.result.content[0].text).courses[0].name).toBe(
      "Math",
    );
  });

  it("reads compact deadlines with attachment references and skips irrelevant submission history", async () => {
    const response = await send("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "list_due_assignments",
          arguments: { dueAfter: "2026-10-01T00:00:00Z" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = await rpc(response as unknown as Response);
    const data = JSON.parse(result.result.content[0].text);
    expect(data.incomplete).toBe(false);
    expect(data.assignments).toHaveLength(1);
    const task = data.assignments[0];
    expect(task.courseName).toBe("Math");
    expect(task.description).toBe("Submit slides");
    expect(task.materials[0].link.url).toBe("https://example.com/material");
    expect(
      task.submission.assignmentSubmission.attachments[0].driveFile.title,
    ).toBe("Slides.pdf");
    expect(task).not.toHaveProperty("maxPoints");
    expect(task.submission).not.toHaveProperty("submissionHistory");
  });
});
