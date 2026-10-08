// Local workerd fixture only. No real login, token or remote KV is used.
import OAuthProvider, {
  OAuthError,
  getOAuthApi,
} from "../node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js";
const RealDate = Date;
let now = RealDate.parse("2026-10-08T00:00:00Z");
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(now);
  }
  static now() {
    return now;
  }
};
let refreshCalls = 0;
let failNext = false;
let staleGrant;
let staleReads = 0;
const origin = "http://localhost:8787";
const options = {
  apiRoute: "/mcp",
  apiHandler: { fetch: () => Response.json({ ok: true }) },
  defaultHandler: { fetch: () => new Response("fixture", { status: 404 }) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  resourceMetadata: { resource: `${origin}/mcp` },
  scopesSupported: ["fixture:read", "fixture:other", "offline_access"],
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 86400,
  tokenExchangeCallback(options) {
    if (options.grantType === "refresh_token") {
      refreshCalls++;
      if (failNext) {
        failNext = false;
        throw new OAuthError("temporarily_unavailable", {});
      }
    }
    // Exercise the key change that happens when either app updates grant props.
    return { newProps: { fixture: true, refreshCalls } };
  },
};
const provider = new OAuthProvider(options);
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) {
      const kv = env.OAUTH_KV;
      const simulated = {
        ...env,
        OAUTH_KV: {
          get: (key, ...args) => {
            if (key.startsWith("grant:") && staleReads > 0) {
              staleReads--;
              return Promise.resolve(JSON.parse(JSON.stringify(staleGrant)));
            }
            return kv.get(key, ...args);
          },
          put: (...args) => kv.put(...args),
          delete: (...args) => kv.delete(...args),
          list: (...args) => kv.list(...args),
        },
      };
      return provider.fetch(request, simulated, ctx);
    }
    const data = await request.json();
    const api = getOAuthApi(options, env);
    if (path === "/fixture/create") {
      const client = await api.createClient({
        redirectUris: ["http://localhost:3000/callback"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
      });
      const authRequest = await api.parseAuthRequest(
        new Request(
          `${origin}/authorize?${new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: "http://localhost:3000/callback",
            response_type: "code",
            scope: "fixture:read fixture:other offline_access",
            code_challenge: data.challenge,
            code_challenge_method: "S256",
            resource: `${origin}/mcp`,
          })}`,
        ),
      );
      const authorized = await api.completeAuthorization({
        request: authRequest,
        userId: "fixture-owner",
        metadata: {},
        scope: authRequest.scope,
        props: { fixture: true },
      });
      return Response.json({
        clientId: client.clientId,
        code: new URL(authorized.redirectTo).searchParams.get("code"),
      });
    }
    if (path === "/fixture/advance") now += data.milliseconds;
    if (path === "/fixture/fail-next") failNext = true;
    if (path === "/fixture/grant") {
      const [userId, grantId] = data.token.split(":");
      const key = `grant:${userId}:${grantId}`;
      const grant = await env.OAUTH_KV.get(key, { type: "json" });
      if (data.staleReads && grant) {
        staleGrant = grant;
        staleReads = data.staleReads;
      }
      if (data.legacy && grant) {
        delete grant.refreshTokenRotationHistory;
        await env.OAUTH_KV.put(key, JSON.stringify(grant));
      }
      if (data.fullHistory && grant) {
        grant.refreshTokenRotationHistory = Array.from(
          { length: 1024 },
          (_, i) => ({
            id: `synthetic-old-hash-${i}`,
            expiresAt: 0,
          }),
        );
        await env.OAUTH_KV.put(key, JSON.stringify(grant));
      }
      return Response.json({ grant, refreshCalls, now });
    }
    return Response.json({ refreshCalls, now });
  },
};
