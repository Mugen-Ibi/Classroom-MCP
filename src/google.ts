import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { Env, GoogleGrant } from "./types";
import {
  MATERIALS_GOOGLE_SCOPE,
  MATERIALS_SCOPE,
  MCP_READ_SCOPES,
} from "./scopes";

export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
] as const;
export function googleScopesFor(mcpScopes: string[]) {
  return [
    "openid",
    "email",
    ...CLASSROOM_SCOPES,
    ...(mcpScopes.includes(MATERIALS_SCOPE) ? [MATERIALS_GOOGLE_SCOPE] : []),
  ];
}
export const GOOGLE_SCOPES = googleScopesFor(MCP_READ_SCOPES);

function hasClassroomReadScopes(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/));
  // Google Auth Platform canonicalizes coursework.me.readonly to this alias.
  return (
    granted.has(CLASSROOM_SCOPES[0]) &&
    (granted.has(CLASSROOM_SCOPES[1]) ||
      granted.has(
        "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
      ))
  );
}

interface GoogleToken {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export function emailAllowed(email: string, allowlist?: string): boolean {
  const allowed = (allowlist ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length === 0 || allowed.includes(email.toLowerCase());
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function googleAuthorizeUrl(
  env: Env,
  state: string,
  challenge: string,
  mcpScopes = MCP_READ_SCOPES,
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/callback`,
    response_type: "code",
    scope: googleScopesFor(mcpScopes).join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function tokenRequest(
  env: Env,
  params: Record<string, string>,
): Promise<GoogleToken> {
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      // Never forward the client secret or refresh token to a redirected origin.
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        ...params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OAuthError("temporarily_unavailable", {
      description: "Google authentication is unavailable. Retry later.",
      statusCode: 503,
    });
  }
  if (!response.ok) {
    // Never relay upstream descriptions: they can contain sensitive details.
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (data?.error === "invalid_grant") {
      throw new OAuthError("invalid_grant", {
        description:
          "Google authorization expired or was revoked. Reconnect this MCP.",
      });
    }
    throw new OAuthError("temporarily_unavailable", {
      description:
        "Google authentication failed. Check OAuth configuration or retry later.",
      statusCode: 503,
    });
  }
  const token = (await response.json().catch(() => null)) as GoogleToken | null;
  if (
    !token ||
    typeof token.access_token !== "string" ||
    !token.access_token ||
    (token.scope !== undefined && typeof token.scope !== "string") ||
    (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== "string" || !token.refresh_token)) ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new OAuthError("temporarily_unavailable", {
      description: "Google returned an invalid token response.",
      statusCode: 503,
    });
  }
  return token;
}

export async function exchangeGoogleCode(
  env: Env,
  code: string,
  verifier: string,
  mcpScopes = MCP_READ_SCOPES,
): Promise<GoogleGrant> {
  const token = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: `${env.PUBLIC_URL}/callback`,
  });
  const granted = (token.scope ?? "").split(/\s+/).filter(Boolean);
  const optionalRequired = googleScopesFor(mcpScopes).filter(
    (scope) => scope === MATERIALS_GOOGLE_SCOPE,
  );
  if (
    !hasClassroomReadScopes(token.scope ?? "") ||
    !token.refresh_token ||
    optionalRequired.some((scope) => !granted.includes(scope))
  ) {
    throw new OAuthError("access_denied", {
      description:
        "Approve the requested Classroom read permissions and offline access, then reconnect. File contents use the separate Google Drive plugin.",
    });
  }
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OAuthError("access_denied", {
      description: "Google account could not be verified.",
    });
  }
  const user = (await response.json().catch(() => null)) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  } | null;
  if (
    !user ||
    typeof user.sub !== "string" ||
    !user.sub ||
    typeof user.email !== "string" ||
    !user.email ||
    user.email_verified !== true ||
    !emailAllowed(user.email, env.ALLOWED_EMAILS)
  ) {
    throw new OAuthError("access_denied", {
      description: "This Google account is not allowed to connect.",
    });
  }
  return {
    userId: user.sub,
    email: user.email,
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshToken: token.refresh_token,
    googleScopes: granted,
  };
}

export async function refreshGoogleGrant(
  env: Env,
  props: GoogleGrant,
): Promise<GoogleGrant> {
  if (!emailAllowed(props.email, env.ALLOWED_EMAILS))
    throw new OAuthError("invalid_grant", {
      description: "This account is no longer allowed.",
    });
  const token = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: props.refreshToken,
  });
  if (token.scope !== undefined && !hasClassroomReadScopes(token.scope)) {
    throw new OAuthError("invalid_grant", {
      description: "Classroom read permissions were revoked. Reconnect.",
    });
  }
  return {
    ...props,
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshToken: token.refresh_token ?? props.refreshToken,
    // An omitted scope retains only previously recorded permissions.
    googleScopes:
      token.scope !== undefined
        ? token.scope.split(/\s+/).filter(Boolean)
        : props.googleScopes,
  };
}
