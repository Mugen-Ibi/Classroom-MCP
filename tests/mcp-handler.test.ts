import { expect, it } from "vitest";
import {
  McpServer,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpHandler } from "../src/mcp-handler";

const origin = "https://fixture.example.test";
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
  const props = { fixture: true };
  const context = {
    props,
    [Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1")]: {
      version: 1,
      props,
      token: "fixture-token",
      clientId: "fixture-client",
      scopes: ["fixture:read"],
      resource: `${origin}/mcp`,
      expiresAt: 2000000000,
    },
  };
  return { handler, contexts, context };
}
function request(method: string, params: object, modern = true) {
  return new Request(`${origin}/mcp`, {
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
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const encoded = response.headers
    .get("Content-Type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6)
    : text;
  return JSON.parse(encoded);
}
it("serves modern list/call requests through fresh SDK servers with verified context", async () => {
  const f = fixture();
  const listed = await rpc(
    await f.handler(request("tools/list", {}), {}, f.context),
  );
  expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["echo"]);
  const called = await rpc(
    await f.handler(
      request("tools/call", {
        name: "echo",
        arguments: { message: "fixture-message" },
      }),
      {},
      f.context,
    ),
  );
  expect(called.result.content).toEqual([
    { type: "text", text: "fixture-message" },
  ]);
  expect(f.contexts).toHaveLength(2);
  expect(f.contexts.map((c) => c.era)).toEqual(["modern", "modern"]);
  expect(f.contexts[0]!.authInfo).toMatchObject({
    clientId: "fixture-client",
    scopes: ["fixture:read"],
    extra: { props: { fixture: true } },
  });
  expect(f.contexts[0]!.authInfo!.resource!.href).toBe(`${origin}/mcp`);
});
it("serves legacy initialize/list/call requests without creating a session", async () => {
  const f = fixture();
  const initialized = await rpc(
    await f.handler(
      request(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
        false,
      ),
      {},
      f.context,
    ),
  );
  expect(initialized.result.serverInfo.name).toBe("fixture");
  const listedResponse = await f.handler(
    request("tools/list", {}, false),
    {},
    f.context,
  );
  expect(listedResponse.headers.has("Mcp-Session-Id")).toBe(false);
  expect((await rpc(listedResponse)).result.tools[0].name).toBe("echo");
  const called = await rpc(
    await f.handler(
      request(
        "tools/call",
        { name: "echo", arguments: { message: "legacy-fixture" } },
        false,
      ),
      {},
      f.context,
    ),
  );
  expect(called.result.content).toEqual([
    { type: "text", text: "legacy-fixture" },
  ]);
  expect(f.contexts.map((c) => c.era)).toEqual(["legacy", "legacy", "legacy"]);
});
it("returns the existing CORS preflight on the configured route", async () => {
  const f = fixture();
  const response = await f.handler(
    new Request(`${origin}/mcp`, {
      method: "OPTIONS",
      headers: { Host: "fixture.example.test", Origin: "https://chatgpt.com" },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
    "Mcp-Method",
  );
  expect(f.contexts).toHaveLength(0);
});
it("keeps the handler scoped to its configured route", async () => {
  const f = fixture();
  expect((await f.handler(new Request(`${origin}/health`))).status).toBe(404);
  expect(f.contexts).toHaveLength(0);
});
