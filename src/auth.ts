import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { exchangeGoogleCode, googleAuthorizeUrl, s256 } from "./google";
import type { Env } from "./types";

export const MCP_SCOPE = "classroom:read";

async function readConsentForm(request: Request): Promise<string | null> {
  const limit = 8192;
  if (
    !request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded") ||
    Number(request.headers.get("Content-Length")) > limit
  ) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function consentPage(
  details: ConsentDescription,
  handle: string,
): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Classroom MCP 接続の許可</title></head><body>
<h1>Google Classroomへの接続を許可</h1>
<p>クライアント: <strong>${escapeHtml(details.clientName)}</strong></p>
<p>${details.clientDomain ? `登録元: ${escapeHtml(details.clientDomain)}` : "このクライアント名は自己申告です。接続を開始したアプリか確認してください。"}</p>
<p>認証情報の返送先: <strong>${escapeHtml(details.redirectHost)}</strong></p>
${details.redirectIsLoopback ? "<p>コンピューター内のアプリに接続権限を渡します。自分で開始した接続であることを確認してください。</p>" : ""}
<p>許可する権限: ${MCP_SCOPE}（授業、公開済み課題、添付資料へのリンク、自分の提出状況の読み取り）</p>
<p>次の画面でGoogleアカウントを選択し、読み取り権限を許可します。接続の継続にはGoogleのオフラインアクセスを使用します。</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">許可してGoogleへ</button> <button name="decision" value="deny">拒否</button></form>
</body></html>`;
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    const securityHeaders = {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.pathname === "/health" && request.method === "GET") {
      const configured = Boolean(
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
      );
      return Response.json(
        {
          service: "classroom-mcp",
          status: configured ? "ok" : "configuration_required",
        },
        { status: configured ? 200 : 503, headers: securityHeaders },
      );
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "Google Classroom Readonly MCP\nMCP endpoint: /mcp\nConnect with an OAuth-capable MCP client.\n",
        { headers: securityHeaders },
      );
    }
    if (!["/authorize", "/callback"].includes(url.pathname))
      return new Response("Not Found", {
        status: 404,
        headers: securityHeaders,
      });
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return new Response(
        "Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Cloudflare Worker Secrets. See README.md.",
        { status: 503, headers: securityHeaders },
      );
    }
    try {
      if (url.pathname === "/authorize") {
        if (request.method === "GET") {
          const authRequest = await oauth.parseAuthRequest(request);
          const details = await oauth.describeConsent(authRequest);
          const consent = await oauth.beginConsent(authRequest);
          consent.headers.set("Content-Type", "text/html; charset=utf-8");
          // no-referrer makes browsers send Origin: null on this form POST.
          // Send only the origin, keeping OAuth query parameters out of Referer.
          consent.headers.set("Referrer-Policy", "origin");
          consent.headers.set("X-Content-Type-Options", "nosniff");
          return new Response(consentPage(details, consent.handle), {
            headers: consent.headers,
          });
        }
        if (request.method === "POST") {
          // Bound form parsing before the browser-bound consent validation.
          if (request.headers.get("Origin") !== env.PUBLIC_URL)
            return new Response("Invalid origin", {
              status: 403,
              headers: securityHeaders,
            });
          const body = await readConsentForm(request);
          if (body === null)
            return new Response("Invalid consent form", {
              status: 400,
              headers: securityHeaders,
            });
          const form = new URLSearchParams(body);
          const handle = form.get("handle") ?? "";
          if (form.get("decision") !== "approve") {
            const denied = await oauth.denyConsent(request, handle);
            return new Response(null, { status: 302, headers: denied.headers });
          }
          const approved = await oauth.approveConsent(request, handle, {
            scope: [MCP_SCOPE, "offline_access"],
          });
          const verifier = crypto.randomUUID() + crypto.randomUUID();
          const upstream = await oauth.beginUpstream(approved.request, {
            data: { verifier },
            headers: approved.headers,
          });
          upstream.headers.set(
            "Location",
            googleAuthorizeUrl(env, upstream.state, await s256(verifier)),
          );
          upstream.headers.set("Referrer-Policy", "no-referrer");
          return new Response(null, { status: 302, headers: upstream.headers });
        }
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        // Recover and consume the browser-bound state before touching Google's code.
        const resumed = await oauth.finishUpstream<{ verifier: string }>(
          request,
        );
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code) {
          resumed.headers.set(
            "Location",
            authorizationErrorRedirect(resumed.request, "access_denied"),
          );
          return new Response(null, { status: 302, headers: resumed.headers });
        }
        const props = await exchangeGoogleCode(
          env,
          code,
          resumed.data.verifier,
        );
        const completed = await oauth.completeAuthorization({
          request: resumed.request,
          userId: props.userId,
          metadata: {},
          scope: resumed.request.scope,
          props,
        });
        resumed.headers.set("Location", completed.redirectTo);
        resumed.headers.set("Referrer-Policy", "no-referrer");
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          ...securityHeaders,
          Allow: url.pathname === "/authorize" ? "GET, POST" : "GET",
        },
      });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo)
        return Response.redirect(error.redirectTo, 302);
      if (
        error instanceof AuthorizationError ||
        error instanceof CimdFetchError
      )
        return new Response(
          "Invalid or expired authorization request. Restart the connection from your MCP client.",
          { status: 400, headers: securityHeaders },
        );
      if (error instanceof OAuthError)
        return new Response(error.description, {
          status: 400,
          headers: securityHeaders,
        });
      return new Response(
        "Authorization is temporarily unavailable. Retry later.",
        { status: 503, headers: securityHeaders },
      );
    }
  },
};
