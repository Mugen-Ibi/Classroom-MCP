import OAuthProvider, {
  insufficientScope,
  type OAuthResourceContext,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler, MCP_SCOPE } from "./auth";
import { ClassroomClient } from "./classroom";
import { emailAllowed, refreshGoogleGrant } from "./google";
import { createClassroomServer } from "./mcp";
import { UNIPA_SCOPE, unipaEnabled } from "./unipa/config";
import { UnipaService, type SnapshotResult } from "./unipa/snapshot";
import { handleNoticeEventRpc } from "./unipa/event-rpc";
import {
  callNoticeMonitor,
  monitorEnabled,
  UNIPA_MONITOR_SCOPE,
} from "./unipa/monitor-worker";
import { UNIPA_POLL_CRON } from "./unipa/polling";
export { UnipaMonitor } from "./unipa/monitor-worker";
import type { Env, GoogleAccess, GoogleGrant } from "./types";

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
    accessTokenProps: { ...accessTokenProps, grantId: options.grantId },
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
        const monitored =
          monitorEnabled(bindings) &&
          ctx.auth.scope.includes(UNIPA_SCOPE) &&
          ctx.auth.scope.includes(UNIPA_MONITOR_SCOPE);
        const monitorGrantId = props.grantId;
        const monitorOwner = {
          userId: props.userId,
          email: props.email,
          grantId: monitorGrantId ?? "",
        };
        if (monitored && !monitorGrantId)
          return new Response(
            "Refresh or reconnect to enable UNIPA monitoring.",
            { status: 401 },
          );
        if (monitored) {
          const eventResponse = await handleNoticeEventRpc(
            request,
            bindings,
            monitorOwner,
          );
          if (eventResponse) return eventResponse;
        }
        return createMcpHandler(
          () =>
            createClassroomServer(
              new ClassroomClient(props.accessToken, request.signal),
              bindings.PUBLIC_URL,
              unipaEnabled(bindings) && ctx.auth.scope.includes(UNIPA_SCOPE)
                ? new UnipaService(
                    bindings,
                    { userId: props.userId, email: props.email },
                    request.signal,
                    undefined,
                    monitored
                      ? {
                          list: async () =>
                            (await callNoticeMonitor(
                              bindings,
                              "list",
                              monitorOwner,
                            )) as SnapshotResult,
                          status: async () =>
                            (await callNoticeMonitor(
                              bindings,
                              "status",
                              monitorOwner,
                            )) as Record<string, unknown>,
                        }
                      : undefined,
                  )
                : undefined,
              monitored
                ? {
                    readBody: (eventId) =>
                      callNoticeMonitor(bindings, "read-body", monitorOwner, {
                        eventId,
                      }),
                    ...(bindings.UNIPA_BACKFILL_ENABLED === "true"
                      ? {
                          prepareBackfill: (input: unknown) =>
                            callNoticeMonitor(
                              bindings,
                              "prepare-backfill",
                              monitorOwner,
                              input,
                            ),
                        }
                      : {}),
                  }
                : undefined,
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
        )(request, bindings, context);
      },
    },
    defaultHandler: authHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [
      MCP_SCOPE,
      ...(unipaEnabled(env) ? [UNIPA_SCOPE] : []),
      ...(monitorEnabled(env) ? [UNIPA_MONITOR_SCOPE] : []),
      "offline_access",
    ],
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
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (controller.cron !== UNIPA_POLL_CRON || !monitorEnabled(env)) return;
    ctx.waitUntil(
      callNoticeMonitor(env, "poll", undefined, {
        scheduledAt: controller.scheduledTime,
      }).catch(() => undefined),
    );
  },
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
