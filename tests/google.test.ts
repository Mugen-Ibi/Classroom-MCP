import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_SCOPES,
  emailAllowed,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  refreshGoogleGrant,
  s256,
} from "../src/google";
import { consentPage } from "../src/auth";
import type { Env, GoogleGrant } from "../src/types";

const env = {
  PUBLIC_URL: "https://classroom.test",
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
} as Env;
const props: GoogleGrant = {
  userId: "u1",
  email: "me@example.com",
  accessToken: "old",
  refreshToken: "refresh",
  expiresAt: 0,
};
afterEach(() => vi.unstubAllGlobals());

describe("Google OAuth", () => {
  it("uses a fixed callback, read scopes, offline access, and S256", async () => {
    const url = new URL(
      googleAuthorizeUrl(env, "state", await s256("verifier")),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://classroom.test/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      `openid email ${CLASSROOM_SCOPES.join(" ")}`,
    );
    expect(CLASSROOM_SCOPES.every((scope) => scope.endsWith(".readonly"))).toBe(
      true,
    );
  });

  it("matches allowed emails exactly and ignores case and surrounding whitespace", () => {
    expect(
      emailAllowed("ME@example.com", " me@example.com, other@example.com "),
    ).toBe(true);
    expect(emailAllowed("attacker@me@example.com", "me@example.com")).toBe(
      false,
    );
  });

  it("refreshes Google credentials and retains the existing refresh token when omitted", async () => {
    const mock = vi.fn(async () =>
      Response.json({ access_token: "new", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", mock);
    const updated = await refreshGoogleGrant(env, props);
    expect(updated.accessToken).toBe("new");
    expect(updated.refreshToken).toBe("refresh");
    expect(updated.expiresAt).toBeGreaterThan(Date.now());
    expect((mock.mock.calls[0]![1] as RequestInit).body?.toString()).toContain(
      "grant_type=refresh_token",
    );
  });

  it("maps revoked access to invalid_grant so MCP clients reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_grant", error_description: "private-token" },
          { status: 400 },
        ),
      ),
    );
    await expect(refreshGoogleGrant(env, props)).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("rejects partial Classroom permissions and unverified identities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "access",
          expires_in: 3600,
          refresh_token: "refresh",
          scope: CLASSROOM_SCOPES[0],
        }),
      ),
    );
    await expect(
      exchangeGoogleCode(env, "code", "verifier"),
    ).rejects.toMatchObject({ code: "access_denied" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("token")
          ? Response.json({
              access_token: "access",
              expires_in: 3600,
              refresh_token: "refresh",
              scope: CLASSROOM_SCOPES.join(" "),
            })
          : Response.json({
              sub: "u",
              email: "me@example.com",
              email_verified: false,
            }),
      ),
    );
    await expect(
      exchangeGoogleCode(env, "code", "verifier"),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("escapes self-declared client metadata in the consent page", () => {
    const html = consentPage(
      {
        clientName: '<script>alert("x")</script>',
        clientDomain: undefined,
        redirectHost: "localhost",
        redirectIsLoopback: true,
        scope: [],
      },
      "handle",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("localhost");
  });
});
