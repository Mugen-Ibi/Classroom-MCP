import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { Env, GoogleGrant } from "./types";

export const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
] as const;
export const GOOGLE_SCOPES = ["openid", "email", ...CLASSROOM_SCOPES];

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
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
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
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (data.error === "invalid_grant") {
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
  const token = (await response.json()) as GoogleToken;
  if (
    !token.access_token ||
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
): Promise<GoogleGrant> {
  const token = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: `${env.PUBLIC_URL}/callback`,
  });
  if (!hasClassroomReadScopes(token.scope ?? "") || !token.refresh_token) {
    throw new OAuthError("access_denied", {
      description:
        "Approve all Classroom read permissions and offline access, then reconnect.",
    });
  }
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new OAuthError("access_denied", {
      description: "Google account could not be verified.",
    });
  const user = (await response.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
  };
  if (
    !user.sub ||
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
  if (token.scope && !hasClassroomReadScopes(token.scope)) {
    throw new OAuthError("invalid_grant", {
      description: "Classroom read permissions were revoked. Reconnect.",
    });
  }
  return {
    ...props,
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    refreshToken: token.refresh_token ?? props.refreshToken,
  };
}
