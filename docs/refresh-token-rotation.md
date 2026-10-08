# MCP refresh token rotation

## Dependency correction

The official `@cloudflare/workers-oauth-provider` 1.2.3 bundle still accepts the
previous refresh token without a deadline and saves a reused token as previous
again. Its public configuration has no rotation replay deadline. See the
[upstream source](https://github.com/cloudflare/workers-oauth-provider) and
[release changes](https://github.com/cloudflare/workers-oauth-provider/blob/main/CHANGELOG.md).

Both the dependency version and upstream bundle SHA-256 are pinned. `npm ci`
applies `scripts/patch-oauth-provider.mjs` via `postinstall`; all configuration,
build, check and deployment npm scripts also verify it. The patch is idempotent
and rejects a different version, upstream bundle or modified patched bundle.
Do not deploy by calling Wrangler directly. On an upstream upgrade, review the
source and regression fixtures and regenerate the patch deliberately.

## Behavior

- A current refresh token rotates normally. A successful rotation records the
  full-token SHA-256 and a fixed 120-second resend deadline, beginning before
  the application callback. Retries never extend that deadline or consent expiry.
- During the deadline, the same resource and requested scope return the original
  access/refresh token pair, with the remaining access-token lifetime. Retries
  make no additional application callback or upstream refresh HTTP request.
  This also supports recent older generations during overlapping retries.
- A known consumed token after its deadline revokes the whole grant and its
  access tokens, and returns `invalid_grant`. Past generation hashes remain
  until grant expiry. Random/unknown tokens and a different authenticated client
  return an error without revoking the grant.
- Previous tokens issued before the patch have no trustworthy deadline and fail
  closed with revocation. An existing current token can rotate into the new
  format. Some clients will need to authorize again when this is deployed.
- Cached responses are encrypted with a fresh upstream AES-GCM key, wrapped
  using the presented refresh token. No raw tokens are added to grant JSON,
  logs, source or fixtures. Expired replay ciphertext is removed at the next
  successful rotation; used hashes are retained.
- A grant allows 1,024 successful rotations before revocation/reconnection.
  This bounds its history size; one refresh per hour over 30 days uses 720.
  At most 16 unexpired replay records are kept. Faster rotation returns a
  retryable 429 with `Retry-After: 120`; it preserves the current token.
- Per-isolate serialization shares one rotation among concurrent requests.
  Its queues are bounded to 128 grants and 32 pending calls per grant. Lock
  exhaustion returns a retryable error and does not revoke authorization.
  Access records are persisted before the replay-bearing grant is published.

## Storage and consistency limits

The history is stored in the existing `OAUTH_KV` grant record; no new binding,
secret, remote permission or scheduled job is introduced. Revoking the grant
also removes its encrypted replay history. A failed application callback does
not consume the token. A KV failure can leave an orphan access record, but no
successful response is returned; existing upstream expiry/purge behavior applies.

This patch addresses the independently reproduced 25-hour reuse under a
consistent view of the grant. It does **not** make KV atomic. Cloudflare documents
[eventual consistency and the lack of transactional read/write](https://developers.cloudflare.com/kv/concepts/how-kv-works/):
even same-region visibility is not guaranteed, and other regions can see stale
values for 60 seconds or more. Separate isolates/regions can still race, lose a
generation/history update, replay an old current view, or recreate a grant during
concurrent revocation. A stale replay record can also return a superseded pair.
Local serialization does not solve those distributed races, and the 120-second
window is not a guaranteed global security bound. A client holding a genuinely
consumed token can intentionally cause its own grant's revocation after the
window; a very late legitimate retry has the same effect and must reconnect.

Strong global single-use and revocation guarantees require a separately reviewed
Durable Object or transactional store coordinating **all** issuance, refresh,
revocation and validation. That needs persistent resources and deployment
approval; it has not been configured or enabled in this local change.

## Verification

`tests/refresh-rotation.test.ts` runs the actual pinned and patched provider in
workerd with ephemeral local KV and a synthetic clock. It covers simultaneous
resends, repeat resends, the exact 120-second boundary, 25-hour and old-generation
reuse, access/current token invalidation, forged/wrong-client denial-of-service
inputs, scope/resource mismatch, callback failure, legacy behavior and size limits.
The existing application Worker fixtures also build against the patched dependency.
A deliberately stale-read fixture also reproduces the remaining lost rotation
despite local serialization. These tests do not simulate actual distributed KV
replication or validate a live client.

No production tokens, real Google login or external notification endpoints were
used. This work remains local until separately authorized for publication and
deployment.
