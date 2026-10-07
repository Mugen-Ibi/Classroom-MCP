import { DurableObject } from "cloudflare:workers";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { unipaConfig, unipaEnabled, UNIPA_SCOPE } from "./config";
import { digest, collectNoticeBoard } from "./notices";
import { importancePolicySchema } from "./importance";
import {
  UnipaNoticeMonitor,
  MonitorError,
  monitorPrincipalSchema,
  type MonitorPrincipal,
} from "./monitor";
import {
  boundedResponseText,
  SubscriptionWebhookTransport,
  callbackHosts,
} from "./webhook";
import { socketWebhookFetch } from "./socket-egress";
import type { Env } from "../types";
import type { UnipaBindings } from "./types";

export const UNIPA_MONITOR_SCOPE = "unipa:monitor";
export function monitorEnabled(env: UnipaBindings): boolean {
  try {
    importancePolicySchema.parse(
      JSON.parse(env.UNIPA_IMPORTANCE_POLICY ?? "{}"),
    );
  } catch {
    return false;
  }
  return (
    env.UNIPA_MONITOR_ENABLED === "true" &&
    Boolean(
      env.UNIPA_MONITOR &&
      (env.UNIPA_WEBHOOK_EGRESS ||
        env.UNIPA_EVENT_DIRECT_EGRESS === "pinned_socket") &&
      callbackHosts(env.UNIPA_EVENT_CALLBACK_HOSTS) &&
      unipaEnabled(env),
    )
  );
}
export async function callNoticeMonitor(
  env: UnipaBindings,
  operation: string,
  owner?: MonitorPrincipal,
  argumentsValue?: unknown,
): Promise<unknown> {
  if (!monitorEnabled(env)) throw new MonitorError(-32001, "MONITOR_DISABLED");
  const stub = env.UNIPA_MONITOR!.get(
    env.UNIPA_MONITOR!.idFromName("single-owner"),
  );
  const response = await stub.fetch(`https://monitor.internal/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, arguments: argumentsValue }),
  });
  const result = (await response.json()) as {
    result?: unknown;
    error?: { code: number; reason: string };
  };
  if (!response.ok || result.error)
    throw new MonitorError(
      result.error?.code ?? -32603,
      result.error?.reason ?? "MONITOR_UNAVAILABLE",
    );
  return result.result;
}

export class UnipaMonitor extends DurableObject<Env> {
  #monitor: UnipaNoticeMonitor;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const oauth = getOAuthApi<Env>(
      {
        apiRoute: "/mcp",
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        resourceMetadata: {
          resource: `${env.PUBLIC_URL}/mcp`,
          authorization_servers: [env.PUBLIC_URL],
        },
        apiHandler: { fetch: async () => new Response("", { status: 403 }) },
        defaultHandler: {
          fetch: async () => new Response("", { status: 403 }),
        },
      },
      env,
    );
    const allowedHosts = callbackHosts(env.UNIPA_EVENT_CALLBACK_HOSTS) ?? [];
    let importance: z.infer<typeof importancePolicySchema>;
    try {
      importance = importancePolicySchema.parse(
        JSON.parse(env.UNIPA_IMPORTANCE_POLICY ?? "{}"),
      );
    } catch {
      importance = importancePolicySchema.parse({}); // readiness gate remains disabled
    }
    this.#monitor = new UnipaNoticeMonitor({
      enabled: monitorEnabled(env),
      bodyEnabled: env.UNIPA_BODY_ENABLED === "true",
      backfillEnabled: env.UNIPA_BACKFILL_ENABLED === "true",
      allowReadStateChange:
        env.UNIPA_MONITOR_ALLOW_READ_STATE_CHANGE === "true",
      importance,
      allowedHosts,
      revision: () => env.UNIPA_AUTH_REVISION ?? "1",
      store: {
        load: () => ctx.storage.get("monitor:v1"),
        save: async (data) => {
          await ctx.storage.put("monitor:v1", data);
          const expiries = [
            ...data.archive.map((item) => item.expiresAt),
            ...data.subscriptions.flatMap((item) => [
              item.expiresAt,
              ...(item.rotationUntil ? [item.rotationUntil] : []),
            ]),
            ...(data.snapshot
              ? [Date.parse(data.snapshot.fetchedAt) + 24 * 3600_000]
              : []),
            ...Object.values(data.state?.records ?? {}).map(
              (item) => item.lastSeenAt + 30 * 24 * 3600_000,
            ),
            ...(data.state?.outbox ?? []).map(
              (item) => Date.parse(item.event.timestamp) + 30 * 24 * 3600_000,
            ),
          ].filter((time) => time > Date.now());
          if (expiries.length)
            await ctx.storage.setAlarm(Math.min(...expiries) + 1);
          else await ctx.storage.deleteAlarm();
        },
      },
      canAccess: async (owner) => {
        try {
          unipaConfig(env, owner);
        } catch {
          return false;
        }
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const grants = await oauth.listUserGrants(owner.userId, {
            limit: 100,
            cursor,
          });
          const grant = grants.items.find((item) => item.id === owner.grantId);
          if (grant)
            return (
              grant.userId === owner.userId &&
              grant.resource === `${env.PUBLIC_URL}/mcp` &&
              (!grant.expiresAt || grant.expiresAt * 1000 > Date.now()) &&
              ["classroom:read", UNIPA_SCOPE, UNIPA_MONITOR_SCOPE].every(
                (scope) => grant.scope.includes(scope),
              )
            );
          if (!grants.cursor) return false;
          cursor = grants.cursor;
        }
        return false;
      },
      scope: async (owner) => {
        const config = unipaConfig(env, owner);
        return digest(JSON.stringify([config.ownerId, config.userId]));
      },
      collect: (owner) => collectNoticeBoard(unipaConfig(env, owner)),
      // Use the pinned socket adapter or an audited service binding; never fall
      // back to unrestricted fetch or the UNIPA credential transport.
      webhook: new SubscriptionWebhookTransport(
        allowedHosts,
        env.UNIPA_WEBHOOK_EGRESS
          ? async (url, init) => {
              // workerd does not support redirect:"error". Manual mode plus an
              // explicit status check enforces the same no-redirect contract.
              const response = await env.UNIPA_WEBHOOK_EGRESS!.fetch(url, {
                ...init,
                redirect: "manual",
              });
              if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                throw new Error("EGRESS_REDIRECT_REJECTED");
              }
              return response;
            }
          : socketWebhookFetch(allowedHosts),
      ),
    });
  }
  async alarm() {
    await this.#monitor.purgeExpired();
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") return new Response("", { status: 405 });
      const input = JSON.parse(
        await boundedResponseText(new Response(request.body), 128 * 1024),
      ) as { owner?: unknown; arguments?: unknown };
      const operation = new URL(request.url).pathname.slice(1);
      let result: unknown;
      if (operation === "poll")
        result = await this.#monitor.poll(
          undefined,
          z
            .object({
              scheduledAt: z.number().finite().nonnegative().optional(),
            })
            .strict()
            .parse(input.arguments ?? {}).scheduledAt,
        );
      else {
        const owner = monitorPrincipalSchema.parse(input.owner);
        if (operation === "events/list")
          result = await this.#monitor.listEvents(owner);
        else if (operation === "events/subscribe")
          result = await this.#monitor.subscribe(owner, input.arguments);
        else if (operation === "events/unsubscribe")
          result = await this.#monitor.unsubscribeRequest(
            owner,
            input.arguments,
          );
        else if (operation === "prepare-backfill")
          result = await this.#monitor.prepareBackfill(owner, input.arguments);
        else if (operation === "read-body")
          result = await this.#monitor.readBody(
            owner,
            z
              .object({ eventId: z.string().regex(/^[a-f0-9]{64}$/) })
              .strict()
              .parse(input.arguments).eventId,
          );
        else if (operation === "list") {
          result = await this.#monitor.readSnapshot(owner);
        } else if (operation === "status")
          result = await this.#monitor.status(owner);
        else throw new MonitorError(-32601, "METHOD_NOT_FOUND");
      }
      return Response.json(
        { result },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return Response.json(
        {
          error: {
            code: error instanceof MonitorError ? error.code : -32603,
            reason:
              error instanceof MonitorError
                ? error.reason
                : "MONITOR_UNAVAILABLE",
          },
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
}
