import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./tests/workers-shim.ts",
        import.meta.url,
      ).pathname.replace(/^\/(\w:)/, "$1"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
