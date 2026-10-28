import type { OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import {
  createMcpHandler as createSdkHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
  type McpServerFactory,
} from "@modelcontextprotocol/server";

interface Options {
  route: string;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
}

function sdkAuthInfo(auth: OAuthResourceAuth): AuthInfo | undefined {
  // The provider permits an unknown client ID; the SDK's metadata requires one.
  // Do not invent an identity. Authentication remains in the protected caller.
  if (!auth.clientId) return undefined;
  return {
    token: auth.token,
    clientId: auth.clientId,
    scopes: [...auth.scope],
    resource: new URL(auth.audience),
    ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
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

// Called only after the existing OAuth/scope/account/Google-expiry gates.
// Use public provider auth fields; never read credentials from request headers.
export function createMcpHandler(factory: McpServerFactory, options: Options) {
  const handler = createSdkHandler(factory, {
    legacy: "stateless",
    // Includes protocol metadata; a JSON-escaped 4,096-character page token fits.
    maxRequestBodySize: 32 * 1024,
  });
  return async (request: Request, auth: OAuthResourceAuth) => {
    try {
      if (new URL(request.url).pathname !== options.route)
        return withCors(new Response("Not Found", { status: 404 }));
      const rejection =
        hostHeaderValidationResponse(request, options.allowedHostnames) ??
        originValidationResponse(request, options.allowedOriginHostnames);
      if (rejection) return withCors(rejection);
      if (request.method === "OPTIONS")
        return withCors(new Response(null, { status: 200 }));
      const authInfo = sdkAuthInfo(auth);
      return withCors(
        await handler.fetch(request, authInfo ? { authInfo } : undefined),
      );
    } catch {
      // Do not log or return request URLs, tokens, auth context or upstream errors.
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
