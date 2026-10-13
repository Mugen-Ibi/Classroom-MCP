# Dependency maintenance

MCP uses the official server/core 2.2.0 combination. A small Worker adapter
delegates modern HTTP and legacy stateless serving to the SDK. Factories return
a fresh Classroom server per request. The five read-only tools do not issue
server-to-client requests or use sessions or the former Agents auth storage helper.

The provider remains upstream 1.2.1. Existing OAuth, scope, account and Google
expiry gates run before the adapter. Public OAuthResourceAuth fields map to SDK
AuthInfo: token, clientId, scope to scopes, audience to resource, and expiresAt.
Without a client ID, optional SDK metadata is omitted rather than inventing an
identity. Application authorization stays in the protected caller. Google grant
props are not copied to SDK metadata. No private symbols or provider hooks are used.

New access tokens contain only classroom:read. The stored grant, Google refresh
token and refresh permissions are retained. This uses the public accessTokenScope
callback result. offline_access remains advertised for refreshing a connection.

Agents and the unused direct client are removed. Agents 0.28.0 still pins older
MCP versions as exact peers, so overriding those peers is avoided.

Stable Wrangler 4.149.0 publishes Miniflare 5.20261006.1-alpha as its dependency.
The runtime fixture pins that same Miniflare version. Its alpha label is part of
the combination shipped by stable Wrangler; an older major would change that
supported combination. Workers types 5.20261006.1 satisfy Wrangler's peer constraint.
Miniflare supplies sharp 0.35.5 directly, so no sharp override is needed.

References: [MCP SDK 2.2.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.2.0),
[public provider context](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md),
[Wrangler 4.149.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler@4.149.0),
[MCP advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
