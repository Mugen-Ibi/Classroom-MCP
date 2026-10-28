import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "../src/mcp-handler";
import { createClassroomServer } from "../src/mcp";
import { ClassroomClient } from "../src/classroom";

const origin = "https://fixture.example.test";
const auth = {
  token: "fixture-token",
  audience: origin + "/mcp",
  clientId: "fixture-client",
  scope: ["classroom:read"],
};
const handler = () =>
  createMcpHandler(
    () =>
      createClassroomServer(
        new ClassroomClient("fixture-google-token"),
        origin,
      ),
    {
      route: "/mcp",
      allowedHostnames: ["fixture.example.test"],
      allowedOriginHostnames: ["fixture.example.test"],
    },
  );
afterEach(() => vi.unstubAllGlobals());

function request(args: object, modern: boolean, padding = "") {
  return new Request(origin + "/mcp", {
    method: "POST",
    headers: {
      Host: "fixture.example.test",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-06-18",
      ...(modern
        ? { "Mcp-Method": "tools/call", "Mcp-Name": "list_courses" }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_courses",
        arguments: args,
        _meta: {
          padding,
          ...(modern
            ? {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              }
            : {}),
        },
      },
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
  ).result;
}

describe.each([false, true])("MCP input budgets (modern=%s)", (modern) => {
  it.each([
    { extra: Array.from({ length: 80 }, () => 0) },
    {
      extra: {
        nested: Object.fromEntries(
          Array.from({ length: 80 }, (_, index) => [String(index), 0]),
        ),
      },
    },
  ])(
    "rejects excessive input members before Zod strips unknown arguments: %j",
    async (args) => {
      const fetch = vi.fn(async () => Response.json({ courses: [] }));
      vi.stubGlobal("fetch", fetch);
      const invoke = handler();
      const result = await rpc(await invoke(request(args, modern), auth));
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      // Rejection must not poison the handler or break a maximum-size valid token.
      const valid = await rpc(
        await invoke(
          request({ pageToken: "\u0000".repeat(4096) }, modern),
          auth,
        ),
      );
      expect(valid.isError).not.toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it("rejects an oversized envelope before tools can run", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await handler()(
      request({}, modern, "x".repeat(33 * 1024)),
      auth,
    );
    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds actual streamed bytes without trusting a small Content-Length", async () => {
    const original = request({}, modern, "x".repeat(33 * 1024));
    const bytes = new TextEncoder().encode(await original.text());
    const headers = new Headers(original.headers);
    headers.set("Content-Length", "1");
    let position = 0;
    const response = await handler()(
      new Request(origin + "/mcp", {
        method: "POST",
        headers,
        body: new ReadableStream({
          pull(controller) {
            if (position >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(position, (position += 1024)));
          },
        }),
        duplex: "half",
      } as RequestInit),
      auth,
    );
    expect(response.status).toBe(413);
  });
});
