# Dependency maintenance

MCP uses the official server/core 2.4.0 combination with Zod 4.6.7. A small Worker adapter
delegates modern HTTP and legacy stateless serving to the SDK. Factories return
a fresh Classroom server per request. The nine read-only tools (one compatibility alias) do not issue
server-to-client requests or use sessions or the former Agents auth storage helper.

The provider uses upstream 1.2.4. Existing OAuth, scope, account and Google
expiry gates run before the adapter. Public OAuthResourceAuth fields map to SDK
AuthInfo: token, clientId, scope to scopes, audience to resource, and expiresAt.
Without a client ID, optional SDK metadata is omitted rather than inventing an
identity. Application authorization stays in the protected caller. Google grant
props are not copied to SDK metadata. No private symbols or provider hooks are used.

New access tokens contain the intersection of approved MCP scopes and recorded
Google permissions: classroom:read and classroom:materials:read.
The retired classroom:attachments:read scope is no longer issued, including
for refreshed legacy grants. Legacy grants keep classroom:read; refreshing never
adds MCP permissions. The stored Google refresh token stays encrypted in grant
props. This uses the public accessTokenScope callback result. offline_access
remains advertised for refreshing a connection.

Attachment text and raw-file retrieval now belong to the connected Google Drive
plugin in the client. The Worker does not call Drive, request drive.readonly,
download attachments or parse file contents. unpdf, fflate and fast-xml-parser
have been removed, together with the retired extraction code and its fixtures.
See [materials](materials.md) for the handoff contract and migration.

## Security updates on 2026-10-28

The initial audit reported six affected packages (four high, two moderate).
The dependency updates below remove all six from the resolved production and
development trees without dependency overrides or suppressing advisories.

| Component           | Previous           | Updated           |
| ------------------- | ------------------ | ----------------- |
| MCP server/core     | 2.2.0              | 2.4.0             |
| Zod                 | 4.6.5              | 4.6.7             |
| Wrangler            | 4.149.0            | 4.154.0           |
| Miniflare           | 5.20261006.1-alpha | 5.20261023.1-beta |
| Workers Types       | 5.20261006.1       | 5.20261023.1      |
| Undici (transitive) | 7.29.1             | 7.30.1            |
| Vite (transitive)   | 8.3.1              | 8.3.5             |

Updating the MCP SDK alone does not enable its input budget. The single Classroom
server constructor sets `maxToolInputElements: 64`, above the largest legitimate
tool's six scalar arguments. The shared modern/legacy adapter sets
`maxRequestBodySize: 32768`, enough for a JSON-escaped 4,096-character page token
and protocol metadata. This rejects oversized envelopes and excess raw argument
members before tool execution or Zod validation. Regression tests cover arrays,
nested objects, falsified Content-Length, both protocol versions, valid calls
after rejection, and concurrent clients with matching JSON-RPC IDs.

The focused input-budget tests reproduced the missing control with the upgraded
SDK before opting in: all eight cases failed because excessive arguments or
envelopes were accepted. After enabling both limits, those cases reject the
inputs and valid maximum-length page tokens still work. The initial security-update validation
on 2026-10-28 passed `npm run check` (11 files, 87 tests),
`npm audit --audit-level=moderate` (zero findings), and `git diff --check`.
The later Drive plugin handoff migration removed the obsolete extraction tests;
its current validation passes 10 files / 78 tests and the audit still reports zero.

The existing fresh-server factory remains in use. Authentication belongs to
Workers OAuth Provider, which exact-checks the token audience against the
configured canonical resource before the application handler. The SDK bearer
helpers affected by its audience advisory are not used. Account, expiry and scope
checks are retained. No authentication checks are relaxed for compatibility.

Run `npm ci`, `npm run check` and `npm audit --audit-level=moderate` to reproduce
validation. CI also runs the audit and fails on moderate-or-higher advisories.
An audit with zero findings confirms the registry's current dependency advisory
status; it does not certify all application behavior or future advisories.

Agents and the unused direct client are removed. Agents 0.28.0 still pins older
MCP versions as exact peers, so overriding those peers is avoided.

Stable Wrangler 4.155.0 publishes Miniflare 5.20261023.2-beta as its dependency.
The runtime fixture pins that same Miniflare version. Its beta label is part of
the combination shipped by stable Wrangler; an older major would change that
supported combination. Workers types 5.20261029.1 satisfy Wrangler's peer constraint.
Miniflare supplies sharp 0.35.5 directly, so no sharp override is needed.

References: [MCP SDK 2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0),
[MCP input-budget advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453),
[MCP isolation advisory](https://github.com/advisories/GHSA-jm63-cq47-j5jp),
[MCP bearer-audience advisory](https://github.com/advisories/GHSA-rvq5-wwqv-78pq),
[public provider context](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md),
[Wrangler 4.154.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.154.0),
[MCP advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).

## Maintenance on 2026-10-29

The resolved toolchain now uses OAuth Provider 1.2.4, Wrangler 4.155.0,
Miniflare 5.20261023.2-beta (the exact runtime bundled by stable Wrangler),
Workers Types 5.20261029.1, Vitest 5.0.5 and Prettier 3.9.10.
The MCP server 2.4.0, Zod 4.6.7 and TypeScript 7.0.2 remain current stable versions.
Miniflare's older `latest` dist-tag is not a compatible substitute for the
runtime bundled by stable Wrangler; the test and build runtime stay aligned.

Google credential-bearing requests now reject redirects instead of following
them. Token and identity payloads receive runtime type checks; an explicitly
empty refresh scope is treated as revoked, while an omitted scope retains only
previously granted scopes. Temporary OAuth errors retain HTTP 503, and health
responses use the JSON media type. Direct assignment reads, like material and
attachment reads, reject unpublished resources. The nine tool names and input
schemas are unchanged, with no new scopes or remote writes.

Local validation on Node 24.19.0 and 26.13.0 passes the aggregate check
(10 files / 93 tests each) and the
registry audit (zero known advisories). Tests use synthetic identities, a local
Google mock and workerd, not real Google accounts. The six-course benchmark
retains 19 API calls and 384,541 upstream bytes; timings are synthetic and do not
establish a live-service performance gain. No deployment was performed.

CI action dependencies are pinned to the official checkout v7.0.1 and setup-node
v7.1.0 commits. The workflow uses ordinary push/pull_request events and no custom
registry authentication, so the v7 fork-trigger and NODE_AUTH_TOKEN changes do
not require an unsafe opt-in. The CI matrix covers Node 24 and 26. Hosted CI on these exact changes remains to be run.

References: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0).
