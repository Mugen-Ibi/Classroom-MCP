# Dependency maintenance

MCP uses the official server/core 2.4.0 combination with Zod 4.6.7. A small Worker adapter
delegates modern HTTP and legacy stateless serving to the SDK. Factories return
a fresh Classroom server per request. The eight read-only tools do not issue
server-to-client requests or use sessions or the former Agents auth storage helper.

The provider remains upstream 1.2.1. Existing OAuth, scope, account and Google
expiry gates run before the adapter. Public OAuthResourceAuth fields map to SDK
AuthInfo: token, clientId, scope to scopes, audience to resource, and expiresAt.
Without a client ID, optional SDK metadata is omitted rather than inventing an
identity. Application authorization stays in the protected caller. Google grant
props are not copied to SDK metadata. No private symbols or provider hooks are used.

New access tokens contain the intersection of approved MCP scopes and recorded
Google permissions: classroom:read, classroom:materials:read and
classroom:attachments:read. Legacy grants keep classroom:read; refreshing never
adds MCP permissions. The stored Google refresh token stays encrypted in grant
props. This uses the public accessTokenScope callback result. offline_access
remains advertised for refreshing a connection.

Attachment parsing adds pinned unpdf 1.9.1 (serverless PDF.js), fflate 0.8.3
(bounded streaming ZIP extraction), and fast-xml-parser 5.11.2 (OOXML text).
No canvas renderer, native binary, OCR service or remote parsing API is used.
The workerd fixture parses actual PDF, DOCX and PPTX bytes. See
[materials](materials.md) for format and resource limits.

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
inputs and valid maximum-length page tokens still work. Clean-install validation
on 2026-10-28 passed `npm run check` (11 files, 87 tests),
`npm audit --audit-level=moderate` (zero findings), and `git diff --check`.

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

Stable Wrangler 4.154.0 publishes Miniflare 5.20261023.1-beta as its dependency.
The runtime fixture pins that same Miniflare version. Its beta label is part of
the combination shipped by stable Wrangler; an older major would change that
supported combination. Workers types 5.20261023.1 satisfy Wrangler's peer constraint.
Miniflare supplies sharp 0.35.5 directly, so no sharp override is needed.

References: [MCP SDK 2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0),
[MCP input-budget advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453),
[MCP isolation advisory](https://github.com/advisories/GHSA-jm63-cq47-j5jp),
[MCP bearer-audience advisory](https://github.com/advisories/GHSA-rvq5-wwqv-78pq),
[public provider context](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md),
[Wrangler 4.154.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.154.0),
[MCP advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
