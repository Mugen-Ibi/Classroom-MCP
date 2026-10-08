import {
  createMcpHandler as createSdkHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
  type McpServerFactory,
} from "@modelcontextprotocol/server";

const verifiedContext = Symbol.for(
  "cloudflare.workers-oauth-provider.verified-context.v1",
);
interface Options {
  route: string;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function verifiedAuthInfo(context: unknown): AuthInfo | undefined {
  if (!context || typeof context !== "object") return undefined;
  const ctx = context as Record<PropertyKey, unknown>;
  const record = ctx[verifiedContext];
  if (record === undefined) return undefined;
  if (!plainRecord(record)) throw new Error("Invalid context");
  const data = record;
  if (
    data.version !== 1 ||
    typeof data.token !== "string" ||
    !data.token ||
    typeof data.clientId !== "string" ||
    !data.clientId ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every((scope) => typeof scope === "string") ||
    !plainRecord(data.props) ||
    data.props !== ctx.props ||
    (data.expiresAt !== undefined &&
      (typeof data.expiresAt !== "number" ||
        !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= 0))
  )
    throw new Error("Invalid context");
  if (data.resource !== undefined && typeof data.resource !== "string")
    throw new Error("Invalid context");
  const resource =
    data.resource === undefined ? undefined : new URL(data.resource);
  if (resource && !["http:", "https:"].includes(resource.protocol))
    throw new Error("Invalid context");
  return {
    token: data.token,
    clientId: data.clientId,
    scopes: [...data.scopes],
    ...(data.expiresAt !== undefined
      ? { expiresAt: data.expiresAt as number }
      : {}),
    ...(resource ? { resource } : {}),
    extra: { props: data.props },
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  );
  headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, headers });
}

// The caller is the OAuth provider's authenticated API handler. The SDK owns
// protocol classification, per-request servers, streaming and legacy transport.
export function createMcpHandler(factory: McpServerFactory, options: Options) {
  const handler = createSdkHandler(
    async (context) => {
      const product = await factory(context);
      if (context.era === "legacy") {
        // Keep the former Worker adapter's immediate reverse-request rejection;
        // a stateless legacy request cannot receive a later client response.
        const protocol = "server" in product ? product.server : product;
        protocol.request = async () => {
          throw new Error(
            "Server-to-client requests are unavailable in stateless legacy serving.",
          );
        };
      }
      return product;
    },
    { legacy: "stateless" },
  );
  return async (request: Request, _env?: unknown, context?: unknown) => {
    try {
      if (new URL(request.url).pathname !== options.route)
        return withCors(new Response("Not Found", { status: 404 }));
      const rejection =
        hostHeaderValidationResponse(request, options.allowedHostnames) ??
        originValidationResponse(request, options.allowedOriginHostnames);
      if (rejection) return withCors(rejection);
      if (request.method === "OPTIONS")
        return withCors(new Response(null, { status: 200 }));
      const authInfo = verifiedAuthInfo(context);
      return withCors(
        await handler.fetch(request, authInfo ? { authInfo } : undefined),
      );
    } catch {
      // No request URLs, auth context, tokens or upstream errors in logs.
      return withCors(
        Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal server error" },
          },
          { status: 500 },
        ),
      );
    }
  };
}
