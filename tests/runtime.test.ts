import { expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { docxFixture, pdfFixture, pptxFixture } from "./document-fixtures";

it("loads the dry-run Worker with the Miniflare version shipped by stable Wrangler", async () => {
  const origin = "http://127.0.0.1:8787";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "classroom-fixture",
          modules: true,
          scriptPath: "dist/index.js",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: { PUBLIC_URL: origin },
        },
      ],
    }),
  );
  try {
    await mf.ready;
    const worker = await mf.getWorker("classroom-fixture");
    const response = await worker.fetch(origin + "/health", {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      service: "classroom-mcp",
      status: "configuration_required",
    });
    const home = await worker.fetch(origin + "/", {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Google Classroom Readonly MCP");
  } finally {
    await mf.dispose();
  }
});

it("serves Classroom MCP in workerd using public auth metadata and a local API mock", async () => {
  // esbuild is supplied by the locked stable Wrangler development dependency.
  const { build } = await import("esbuild");
  const bundle = await build({
    entryPoints: ["tests/mcp-runtime-entry.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    target: "es2022",
    write: false,
  });
  const origin = "http://127.0.0.1:8787";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "mcp-fixture",
          modules: true,
          script: bundle.outputFiles[0]!.text,
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          outboundService: "google-mock",
        },
        {
          name: "google-mock",
          modules: [{ type: "ESModule", path: "tests/google-mock.js" }],
          compatibilityDate: "2026-10-01",
        },
      ],
    }),
  );
  try {
    await mf.ready;
    const worker = await mf.getWorker("mcp-fixture");
    async function rpc(method: string, params: object) {
      const response = await worker.fetch(origin + "/mcp", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:8787",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(
        response.headers.get("Content-Type")?.includes("text/event-stream")
          ? body
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6)
          : body,
      ).result;
    }
    const listed = await rpc("tools/list", {});
    expect(
      listed.tools.map((tool: { name: string }) => tool.name).sort(),
    ).toEqual([
      "get_assignment",
      "get_attachment_content",
      "get_material",
      "list_assignments",
      "list_courses",
      "list_due_assignments",
      "list_materials",
      "list_my_submissions",
    ]);
    const called = await rpc("tools/call", {
      name: "list_courses",
      arguments: {},
    });
    expect(called.isError).not.toBe(true);
    expect(JSON.parse(called.content[0].text).courses).toEqual([
      { id: "c1", name: "Math", section: "A" },
    ]);
    for (const [mimeType, bytes, expected] of [
      ["application/pdf", pdfFixture("AB", false, true), "講義"],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        docxFixture(),
        "講義 & 資料",
      ],
      [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pptxFixture(),
        "[Slide 1]\nFirst slide",
      ],
    ] as const) {
      const parsed = await worker.fetch(origin + "/extract", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: bytes,
      });
      expect(parsed.status, await parsed.clone().text()).toBe(200);
      expect((await parsed.json()).text).toContain(expected);
    }
  } finally {
    await mf.dispose();
  }
});
