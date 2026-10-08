// Injected into the pinned upstream bundle by scripts/patch-oauth-provider.mjs.
// Helpers use upstream crypto and OAuthError; this file is never a separate Worker.
const refreshGrantLocks = new Map();
async function withRefreshGrantLock(key, run) {
  let lock = refreshGrantLocks.get(key);
  if (!lock) {
    if (refreshGrantLocks.size >= 128)
      throw new OAuthError("temporarily_unavailable", { statusCode: 429 });
    lock = { tail: Promise.resolve(), pending: 0 };
    refreshGrantLocks.set(key, lock);
  }
  if (lock.pending >= 32)
    throw new OAuthError("temporarily_unavailable", { statusCode: 429 });
  lock.pending++;
  const predecessor = lock.tail;
  let release;
  lock.tail = new Promise((resolve) => (release = resolve));
  await predecessor;
  try {
    return await run();
  } finally {
    release();
    if (--lock.pending === 0) refreshGrantLocks.delete(key);
  }
}

async function rejectRefreshReuse(provider, env, userId, grantId) {
  // Called only after authenticated client ownership and a known full-token hash.
  // Random/malformed tokens and wrong clients must not revoke someone else's grant.
  await provider.createOAuthHelpers(env).revokeGrant(grantId, userId);
  throw new OAuthError("invalid_grant", {
    description: "Refresh token reuse detected. Reconnect this MCP.",
  });
}

async function replayRefreshResponse(record, token, audience, scopes) {
  const key = await unwrapKeyWithToken(token, record.replay.wrappedKey);
  const cached = await decryptProps(key, record.replay.encryptedData);
  if (
    cached.resource !== audience ||
    JSON.stringify(record.replay.requestedScopes) !==
      JSON.stringify([...scopes].sort())
  )
    throw new OAuthError("invalid_request", {
      description: "Refresh retries must use the original resource and scope.",
    });
  return new Response(
    JSON.stringify({
      ...cached,
      expires_in: Math.max(
        0,
        cached.expires_in +
          record.replay.issuedAt -
          Math.floor(Date.now() / 1000),
      ),
    }),
    { headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS } },
  );
}
