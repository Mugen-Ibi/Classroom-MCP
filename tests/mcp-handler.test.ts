import { expect, it } from "vitest";
import {
  McpServer,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { createMcpHandler } from "../src/mcp-handler";

const origin = "https://fixture.example.test";
const auth: OAuthResourceAuth = {
  token: "fixture-token",
  audience: origin + "/mcp",
  clientId: "fixture-client",
  scope: ["classroom:read"],
  expiresAt: 2000000000,
};
function fixture() {
  const contexts: McpRequestContext[] = [];
  const handler = createMcpHandler(
    (context) => {
      contexts.push(context);
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool(
        "echo",
        {
          inputSchema: { message: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ message }) => ({ content: [{ type: "text", text: message }] }),
      );
      return server;
    },
    {
      route: "/mcp",
      allowedHostnames: ["fixture.example.test"],
      allowedOriginHostnames: ["chatgpt.com", "fixture.example.test"],
    },
  );
  return { handler, contexts };
}
function request(method: string, params: object, modern = true) {
  return new Request(origin + "/mcp", {
    method: "POST",
    headers: {
      Host: "fixture.example.test",
      Origin: "https://chatgpt.com",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(modern
        ? {
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(method === "tools/call" ? { "Mcp-Name": "echo" } : {}),
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : params,
    }),
  });
}
async function rpc(response: Response) {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(
    response.headers.get("Content-Type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : body,
  );
}
it("serves modern list/call through fresh servers with public provider metadata", async () => {
  const f = fixture();
  const listed = await rpc(await f.handler(request("tools/list", {}), auth));
  expect(
    listed.result.tools.map((tool: { name: string }) => tool.name),
  ).toEqual(["echo"]);
  const called = await rpc(
    await f.handler(
      request("tools/call", {
        name: "echo",
        arguments: { message: "fixture-message" },
      }),
      auth,
    ),
  );
  expect(called.result.content).toEqual([
    { type: "text", text: "fixture-message" },
  ]);
  expect(f.contexts.map((context) => context.era)).toEqual([
    "modern",
    "modern",
  ]);
  expect(f.contexts[0]!.authInfo).toMatchObject({
    token: auth.token,
    clientId: auth.clientId,
    scopes: ["classroom:read"],
    expiresAt: auth.expiresAt,
  });
  expect(f.contexts[0]!.authInfo!.resource!.href).toBe(origin + "/mcp");
  expect(f.contexts[0]!.authInfo!.extra).toBeUndefined();
  expect(f.contexts[0]!.authInfo!.scopes).not.toBe(auth.scope);
});
it("serves legacy initialize/list/call without a session", async () => {
  const f = fixture();
  const initialized = await rpc(
    await f.handler(
      request(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
        false,
      ),
      auth,
    ),
  );
  expect(initialized.result.serverInfo.name).toBe("fixture");
  const response = await f.handler(request("tools/list", {}, false), auth);
  expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  expect((await rpc(response)).result.tools[0].name).toBe("echo");
  const called = await rpc(
    await f.handler(
      request(
        "tools/call",
        {
          name: "echo",
          arguments: { message: "legacy-fixture" },
        },
        false,
      ),
      auth,
    ),
  );
  expect(called.result.content).toEqual([
    { type: "text", text: "legacy-fixture" },
  ]);
  expect(f.contexts.map((context) => context.era)).toEqual([
    "legacy",
    "legacy",
    "legacy",
  ]);
});
it("returns CORS preflight without allocating a server", async () => {
  const f = fixture();
  const response = await f.handler(
    new Request(origin + "/mcp", {
      method: "OPTIONS",
      headers: { Host: "fixture.example.test", Origin: "https://chatgpt.com" },
    }),
    auth,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
    "Mcp-Name",
  );
  expect(f.contexts).toHaveLength(0);
});
it("keeps the configured route separate from public routes", async () => {
  const f = fixture();
  expect((await f.handler(new Request(origin + "/health"), auth)).status).toBe(
    404,
  );
  expect(f.contexts).toHaveLength(0);
});
it("retains stateless legacy GET/DELETE responses", async () => {
  const f = fixture();
  for (const method of ["GET", "DELETE"]) {
    const response = await f.handler(
      new Request(origin + "/mcp", {
        method,
        headers: {
          Host: "fixture.example.test",
          "MCP-Protocol-Version": "2025-06-18",
        },
      }),
      auth,
    );
    expect(response.status).toBe(405);
    expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  }
  expect(f.contexts).toHaveLength(0);
});
it("keeps configured Host and Origin routing checks", async () => {
  const f = fixture();
  for (const headers of [
    { Host: "other.example.test", Origin: "https://chatgpt.com" },
    { Host: "fixture.example.test", Origin: "https://other.example.test" },
  ]) {
    const response = await f.handler(
      new Request(origin + "/mcp", { method: "OPTIONS", headers }),
      auth,
    );
    expect(response.status).toBe(403);
  }
  expect(f.contexts).toHaveLength(0);
});
it("does not invent SDK client metadata for a provider without a client ID", async () => {
  const f = fixture();
  const { clientId: _clientId, ...withoutClientId } = auth;
  expect(
    (await rpc(await f.handler(request("tools/list", {}), withoutClientId)))
      .result.tools,
  ).toHaveLength(1);
  expect(f.contexts[0]!.authInfo).toBeUndefined();
});
