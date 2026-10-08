# Dependency maintenance

MCP uses `@modelcontextprotocol/server` 2.2.0 and its matching core. The small
Worker adapter in `src/mcp-handler.ts` calls the SDK's native stateless handler.
It preserves the configured route, SDK Host/Origin checks, CORS, verified OAuth
context and immediate rejection of reverse requests in stateless legacy serving.
Tool factories remain fresh per request. OAuth verification still belongs to
the existing OAuth provider; the adapter does not authenticate HTTP credentials.

The unused client package and Agents SDK were removed. Agents 0.24.0 through
0.27.0 pin earlier MCP versions as peers; overriding those peers would violate
their published compatibility constraints. This project used only their HTTP
handler adapter, so the SDK's supported API replaces that dependency without
changing grant storage or adding bindings.

Miniflare's `sharp` is temporarily overridden to the official 0.35.5 patch release
to pick up its fixed librsvg dependency. Wrangler and Miniflare versions stay
unchanged. Remove the narrowly scoped override when Miniflare adopts a fixed
version. No audit exclusions or forced major/downgrade updates are used.

References: [MCP 2.2.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.2.0),
[MCP SDK advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h),
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).

`npm ci` must still apply the separately pinned OAuth provider patch.
See [refresh token rotation](refresh-token-rotation.md) for that patch and its
consistency limits. Dependency audit success does not establish those guarantees.
