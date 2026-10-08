import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const bundle = new URL(
  "node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js",
  root,
);
const version = JSON.parse(
  readFileSync(
    new URL(
      "node_modules/@cloudflare/workers-oauth-provider/package.json",
      root,
    ),
    "utf8",
  ),
).version;
const upstreamHash =
  "9e161d2ed057f0b8c834cfc6dceb6a28de2422497820ad8ea93979fa5b2b562e";
const patchedHash =
  "4347c1e7cf3419d5a31aaf68a28c9b40feae04254358ed2b60d9c9e5d9d407a4";
const hash = (text) => createHash("sha256").update(text).digest("hex");
let source = readFileSync(bundle, "utf8");
const marker = "// Local bounded refresh rotation patch v1";
if (version !== "1.2.3") throw new Error("OAuth patch: unsupported version");
if (source.includes(marker)) {
  if (hash(source) !== patchedHash)
    throw new Error("OAuth patch: modified patched bundle");
} else {
  if (hash(source) !== upstreamHash)
    throw new Error("OAuth patch: unsupported upstream bundle");
  const helpers = readFileSync(
    new URL("patches/refresh-token-rotation.js", root),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = source.indexOf(
    "\tasync handleRefreshTokenGrant(body, clientInfo, env) {",
  );
  const end = source.indexOf("\n\t/**", start);
  if (start < 0 || end < 0) throw new Error("OAuth patch: method not found");
  let method = source.slice(start, end);
  const replaceOnce = (before, after) => {
    if (method.split(before).length !== 2)
      throw new Error("OAuth patch: unexpected upstream method");
    method = method.replace(before, after);
  };
  replaceOnce(
    "\tasync handleRefreshTokenGrant(body, clientInfo, env) {",
    `\tasync handleRefreshTokenGrant(body, clientInfo, env) {
      const parts = typeof body.refresh_token === "string" ? body.refresh_token.split(":") : [];
      if (parts.length !== 3) return this.handleBoundedRefreshTokenGrant(body, clientInfo, env);
      return withRefreshGrantLock(parts.slice(0, 2).join(":"), () => this.handleBoundedRefreshTokenGrant(body, clientInfo, env));
    }
    async handleBoundedRefreshTokenGrant(body, clientInfo, env) {`,
  );
  // Move client ownership validation before any reuse-triggered revocation.
  const clientCheck = `\t\tif (grantData.clientId !== clientInfo.clientId) return this.createErrorResponse("invalid_grant", { description: "Client ID mismatch" }, {
\t\t\tcategory: "refresh-token-grant",
\t\t\treason: "client_mismatch"
\t\t});`;
  replaceOnce(clientCheck, "");
  replaceOnce(
    "\t\tconst isCurrentToken = grantData.refreshTokenId === providedTokenHash;",
    `${clientCheck}
      const rotationHistory = grantData.refreshTokenRotationHistory ?? [];
      const usedToken = rotationHistory.find(record => record.id === providedTokenHash);
      const isCurrentToken = grantData.refreshTokenId === providedTokenHash;
      if ((!isCurrentToken && grantData.previousRefreshTokenId === providedTokenHash && !usedToken) ||
          (usedToken && (!usedToken.replay || Math.floor(Date.now() / 1000) >= usedToken.expiresAt)))
        return rejectRefreshReuse(this, env, userId, grantId);`,
  );
  replaceOnce(
    "if (!isCurrentToken && !isPreviousToken)",
    "if (!isCurrentToken && !isPreviousToken && !usedToken)",
  );
  replaceOnce(
    "\t\tconst newAccessToken =",
    `      const requestedReplayScopes = this.downscope(body.scope, grantData.scope);
      if (grantsNoneOfTheRequestedScopes(body.scope, requestedReplayScopes))
        throw new OAuthError("invalid_scope", { description: "None of the requested scopes were granted" });
      if (usedToken) return replayRefreshResponse(usedToken, refreshToken, audience, requestedReplayScopes);
      if (rotationHistory.length >= 1024) return rejectRefreshReuse(this, env, userId, grantId);
      const rotationStartedAt = Math.floor(Date.now() / 1000);
      for (const record of rotationHistory)
        if (record.expiresAt <= rotationStartedAt) delete record.replay;
      if (rotationHistory.filter(record => record.replay).length >= 16)
        throw new OAuthError("temporarily_unavailable", { statusCode: 429, headers: { "Retry-After": "120" } });
\t\tconst newAccessToken =`,
  );
  const response = `\t\tconst tokenResponse = {
\t\t\taccess_token: newAccessToken,
\t\t\ttoken_type: "bearer",
\t\t\texpires_in: accessTokenTTL,
\t\t\trefresh_token: newRefreshToken,
\t\t\tscope: tokenScopes.join(" "),
\t\t\tresource: audience
\t\t};`;
  replaceOnce(response, "");
  replaceOnce(
    "\t\tgrantData.previousRefreshTokenId = providedTokenHash;",
    `${response}
      const replay = await encryptProps(tokenResponse);
      rotationHistory.push({
        id: providedTokenHash,
        expiresAt: rotationStartedAt + 120,
        replay: {
          encryptedData: replay.encryptedData,
          wrappedKey: await wrapKeyWithToken(refreshToken, replay.key),
          requestedScopes: [...requestedReplayScopes].sort(),
          issuedAt: now
        }
      });
      grantData.refreshTokenRotationHistory = rotationHistory;
\t\tgrantData.previousRefreshTokenId = providedTokenHash;`,
  );
  // Do not expose a replay until its access-token record was saved successfully.
  replaceOnce(
    "\t\tawait this.saveGrantWithTTL(env, grantKey, grantData, now);",
    "",
  );
  replaceOnce(
    "\t\treturn new Response(JSON.stringify(tokenResponse)",
    "\t\tawait this.saveGrantWithTTL(env, grantKey, grantData, now);\n\t\treturn new Response(JSON.stringify(tokenResponse)",
  );
  source = `${marker}\n${helpers}\n${source.slice(0, start)}${method}${source.slice(end)}`;
  if (hash(source) !== patchedHash)
    throw new Error(
      "OAuth patch: recipe does not match reviewed patched bundle",
    );
  writeFileSync(fileURLToPath(bundle), source);
  console.log(`Applied OAuth refresh rotation patch (${hash(source)})`);
}
