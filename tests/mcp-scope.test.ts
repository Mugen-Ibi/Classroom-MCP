import { expect, it } from "vitest";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { exchangeMcpToken } from "../src/index";
import type { Env, GoogleGrant } from "../src/types";
import {
  ATTACHMENTS_GOOGLE_SCOPE,
  MATERIALS_GOOGLE_SCOPE,
  MCP_READ_SCOPES,
} from "../src/scopes";

function fixture(requestedScope: string[]) {
  const grant: GoogleGrant = {
    userId: "fixture-user",
    email: "student@example.test",
    accessToken: "fixture-google-access",
    refreshToken: "fixture-google-refresh",
    expiresAt: Date.now() + 3600000,
  };
  const options = {
    grantType: "authorization_code",
    props: grant,
    requestedScope,
    env: {} as Env,
  } as TokenExchangeCallbackOptions<Env>;
  return { options, grant };
}
it("keeps offline refresh permission in the grant rather than the access-token scope", async () => {
  const { options, grant } = fixture(["classroom:read", "offline_access"]);
  const result = await exchangeMcpToken(options);
  expect(result.accessTokenScope).toEqual(["classroom:read"]);
  expect(result.newProps).toBe(grant);
  expect(result.accessTokenProps).not.toHaveProperty("refreshToken");
  expect(result.accessTokenProps).toMatchObject({
    accessToken: grant.accessToken,
    email: grant.email,
  });
  expect(options.requestedScope).toEqual(["classroom:read", "offline_access"]);
  expect(result.accessTokenTTL).toBeGreaterThan(0);
  expect(result.accessTokenTTL).toBeLessThanOrEqual(3600);
});

it("grants new MCP permissions only when both MCP consent and Google permissions exist", async () => {
  const { options, grant } = fixture([...MCP_READ_SCOPES, "offline_access"]);
  expect((await exchangeMcpToken(options)).accessTokenScope).toEqual([
    "classroom:read",
  ]);
  grant.googleScopes = [MATERIALS_GOOGLE_SCOPE];
  expect((await exchangeMcpToken(options)).accessTokenScope).toEqual([
    "classroom:read",
    "classroom:materials:read",
  ]);
  grant.googleScopes.push(ATTACHMENTS_GOOGLE_SCOPE);
  expect((await exchangeMcpToken(options)).accessTokenScope).toEqual(
    MCP_READ_SCOPES,
  );
  options.requestedScope = ["classroom:read"];
  expect((await exchangeMcpToken(options)).accessTokenScope).toEqual([
    "classroom:read",
  ]);
});
it("limits an existing multi-permission request without mutating its grant or requested scopes", async () => {
  const { options, grant } = fixture([
    "classroom:read",
    "offline_access",
    "previous-service:read",
  ]);
  const result = await exchangeMcpToken(options);
  expect(result.accessTokenScope).toEqual(["classroom:read"]);
  expect(result.newProps).toBe(grant);
  expect(grant.refreshToken).toBe("fixture-google-refresh");
  expect(options.requestedScope).toEqual([
    "classroom:read",
    "offline_access",
    "previous-service:read",
  ]);
});
