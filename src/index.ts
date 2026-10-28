import OAuthProvider, {
  insufficientScope,
  type OAuthResourceContext,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "./mcp-handler";
import { authHandler, MCP_SCOPE } from "./auth";
import { ClassroomClient } from "./classroom";
import { emailAllowed, refreshGoogleGrant } from "./google";
import { createClassroomServer } from "./mcp";
import type { Env, GoogleAccess, GoogleGrant } from "./types";
import { MCP_READ_SCOPES, permitsMcpScope } from "./scopes";

export async function exchangeMcpToken(
  options: TokenExchangeCallbackOptions<Env>,
) {
  const grant =
    options.grantType === "refresh_token"
      ? await refreshGoogleGrant(options.env, options.props as GoogleGrant)
      : (options.props as GoogleGrant);
  // Keep the Google refresh token in the encrypted grant only, not the access-token props.
  const { refreshToken: _refreshToken, ...accessTokenProps } = grant;
  return {
    newProps: grant,
    accessTokenProps,
    // Intersect the approved MCP scopes with actual Google permissions.
    accessTokenScope: options.requestedScope.filter((scope) =>
      permitsMcpScope(scope, grant.googleScopes),
    ),
    accessTokenTTL: Math.max(
      1,
      Math.min(3600, Math.floor((grant.expiresAt - Date.now()) / 1000) - 60),
    ),
  };
}

function createProvider(env: Env) {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, bindings, context) {
        const ctx = context as OAuthResourceContext<GoogleAccess>;
        if (!ctx.auth.scope.includes(MCP_SCOPE))
          return insufficientScope(ctx.auth, [MCP_SCOPE]);
        const props = ctx.props;
        if (
          !props?.accessToken ||
          props.expiresAt <= Date.now() ||
          !emailAllowed(props.email, bindings.ALLOWED_EMAILS)
        ) {
          return new Response(
            "Google authorization expired or the account is no longer allowed. Refresh or reconnect.",
            {
              status: 401,
              headers: {
                "WWW-Authenticate": 'Bearer error="invalid_token"',
                "Cache-Control": "no-store",
              },
            },
          );
        }
        const hostname = new URL(bindings.PUBLIC_URL).hostname;
        return createMcpHandler(
          () =>
            createClassroomServer(
              new ClassroomClient(props.accessToken, request.signal),
              bindings.PUBLIC_URL,
              ctx.auth.scope.filter((scope) =>
                permitsMcpScope(scope, props.googleScopes),
              ),
              props.email,
            ),
          {
            route: "/mcp",
            allowedHostnames: [
              hostname,
              ...(["localhost", "127.0.0.1", "[::1]"].includes(hostname)
                ? ["localhost", "127.0.0.1", "[::1]"]
                : []),
            ],
            allowedOriginHostnames: [
              new URL(bindings.PUBLIC_URL).hostname,
              "chatgpt.com",
              "chat.openai.com",
              "localhost",
              "127.0.0.1",
            ],
          },
        )(request, ctx.auth);
      },
    },
    defaultHandler: authHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...MCP_READ_SCOPES, "offline_access"],
    requiredScopes: [MCP_SCOPE],
    resourceMetadata: {
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
      resource_name: "Google Classroom Readonly MCP",
    },
    tokenExchangeCallback: exchangeMcpToken,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const publicUrl = new URL(env.PUBLIC_URL);
      // Use the configured canonical origin for OAuth discovery and callback URLs.
      if (
        publicUrl.origin !== env.PUBLIC_URL ||
        new URL(request.url).origin !== publicUrl.origin
      )
        return new Response("Invalid host", { status: 403 });
      return await createProvider(env).fetch(request, env, ctx);
    } catch {
      // Do not emit request URLs, auth codes, bearer tokens, or upstream errors in logs.
      return new Response(
        "Service is temporarily unavailable. Check Worker bindings and configuration.",
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
