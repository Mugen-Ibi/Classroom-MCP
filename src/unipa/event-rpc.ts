import { z } from "zod";
import { callNoticeMonitor, monitorEnabled } from "./monitor-worker";
import { MonitorError, type MonitorPrincipal } from "./monitor";
import { boundedResponseText } from "./webhook";
import type { UnipaBindings } from "./types";

// SDK 2.0's capabilities schema strips unknown `events`. Handle this optional
// extension on the SAME authenticated endpoint, after OAuth/scope validation.
export async function handleNoticeEventRpc(
  request: Request,
  env: UnipaBindings,
  owner: MonitorPrincipal,
): Promise<Response | null> {
  if (
    !monitorEnabled(env) ||
    request.method !== "POST" ||
    !request.headers.get("Content-Type")?.startsWith("application/json")
  )
    return null;
  let id: string | number | null = null;
  try {
    const raw = JSON.parse(
      await boundedResponseText(new Response(request.clone().body), 128 * 1024),
    ) as Record<string, unknown>;
    if (
      typeof raw.method !== "string" ||
      (raw.method !== "server/discover" && !raw.method.startsWith("events/"))
    )
      return null;
    const parsed = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string().max(128), z.number().int()]),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) throw new MonitorError(-32600, "INVALID_REQUEST");
    id = parsed.data.id;
    const params = { ...(parsed.data.params ?? {}) };
    const revision = request.headers.get("MCP-Protocol-Version");
    if (revision !== null || raw.method !== "server/discover") {
      const meta = z
        .object({
          "io.modelcontextprotocol/protocolVersion": z.literal("2026-07-28"),
          "io.modelcontextprotocol/clientCapabilities": z
            .record(z.string(), z.unknown())
            .optional(),
        })
        .passthrough()
        .safeParse(params._meta);
      if (revision !== "2026-07-28" || !meta.success)
        throw new MonitorError(-32602, "INVALID_MCP_ENVELOPE");
      if (
        request.headers.get("Mcp-Method") !== raw.method ||
        (typeof params.name === "string" &&
          request.headers.has("Mcp-Name") &&
          request.headers.get("Mcp-Name") !== params.name)
      )
        throw new MonitorError(-32020, "INVALID_MCP_HEADER_MATCH");
    }
    delete params._meta;
    let result: unknown;
    if (raw.method === "server/discover") {
      await callNoticeMonitor(env, "events/list", owner, {});
      result = {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, events: {} },
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "google-classroom-readonly",
            title: "Classroom MCP",
            version: "1.0.0",
          },
        },
      };
    } else if (
      ["events/list", "events/subscribe", "events/unsubscribe"].includes(
        raw.method,
      )
    ) {
      if (raw.method === "events/list" && Object.keys(params).length)
        throw new MonitorError(-32602, "INVALID_EVENT_FILTERS");
      result = await callNoticeMonitor(env, raw.method, owner, params);
    } else throw new MonitorError(-32601, "METHOD_NOT_FOUND");
    return Response.json(
      { jsonrpc: "2.0", id, result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = error instanceof MonitorError ? error.code : -32603;
    const reason =
      error instanceof MonitorError ? error.reason : "MONITOR_UNAVAILABLE";
    return Response.json(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message: reason,
          ...(code === -32015 ? { data: { reason } } : {}),
        },
      },
      {
        status: reason.startsWith("INVALID_MCP_") ? 400 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
