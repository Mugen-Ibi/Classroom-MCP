import { afterEach, expect, it, vi } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { ClassroomClient } from "../src/classroom";
import { createClassroomServer } from "../src/mcp";

afterEach(() => vi.unstubAllGlobals());

it("offers eight read-only Classroom tools and keeps new tools gated for legacy connections", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      courses: [{ id: "fixture-course", name: "Fixture course" }],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const handler = createMcpHandler(
    () =>
      createClassroomServer(
        new ClassroomClient("fixture-google-token"),
        "https://classroom.example.test",
      ),
    { legacy: "stateless" },
  );
  async function rpc(method: string, params: object) {
    const response = await handler.fetch(
      new Request("https://classroom.example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
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
  expect(
    listed.tools.every(
      (tool: { annotations: { readOnlyHint: boolean } }) =>
        tool.annotations.readOnlyHint,
    ),
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  const called = await rpc("tools/call", {
    name: "list_courses",
    arguments: {},
  });
  expect(called.isError).not.toBe(true);
  expect(JSON.parse(called.content[0].text).courses).toEqual([
    { id: "fixture-course", name: "Fixture course" },
  ]);
  expect(fetch).toHaveBeenCalledOnce();
  const gated = await rpc("tools/call", {
    name: "list_materials",
    arguments: { courseId: "c1" },
  });
  expect(gated.isError).toBe(true);
  expect(gated.content[0].text).toContain("Reconnect");
  expect(fetch).toHaveBeenCalledOnce();
  const invalidAttachment = await rpc("tools/call", {
    name: "get_attachment_content",
    arguments: {
      courseId: "c1",
      sourceType: "material",
      sourceId: "m1",
      attachmentIndex: -1,
    },
  });
  expect(invalidAttachment.isError).toBe(true);
});
