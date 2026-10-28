import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassroomClient } from "../src/classroom";
import { MAX_FILE_BYTES } from "../src/documents";
import { pdfFixture } from "./document-fixtures";

const material = {
  id: "m1",
  courseId: "c1",
  title: "配布資料",
  state: "PUBLISHED",
  description: "今週の資料",
  materials: [
    { driveFile: { driveFile: { id: "attached-file", title: "Lecture" } } },
  ],
};
const args = {
  courseId: "c1",
  sourceType: "material" as const,
  sourceId: "m1",
  attachmentIndex: 0,
};
const metadata = {
  id: "attached-file",
  name: "Lecture",
  mimeType: "text/plain",
  version: "1",
  capabilities: { canDownload: true },
};
afterEach(() => vi.unstubAllGlobals());

function upstream(
  options: { file?: object; parent?: object; content?: () => Response } = {},
) {
  const mock = vi.fn(async (url: URL) => {
    if (url.hostname === "classroom.googleapis.com")
      return Response.json(options.parent ?? material);
    if (url.searchParams.has("alt") || url.pathname.endsWith("/export"))
      return options.content?.() ?? new Response("授業資料の本文です。");
    return Response.json({ ...metadata, ...options.file });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("General Classroom materials and scoped attachment reads", () => {
  it("uses the singular response key, published state and identical paging conditions", async () => {
    const mock = vi.fn(async (url: URL) =>
      Response.json(
        url.searchParams.has("pageToken")
          ? { courseWorkMaterial: [material] }
          : { nextPageToken: "next" },
      ),
    );
    vi.stubGlobal("fetch", mock);
    const client = new ClassroomClient("secret");
    const first = await client.listMaterials({
      courseId: "d:alias",
      pageSize: 2,
    });
    expect(first.materials).toEqual([]);
    expect(first.nextPageToken).toBe("next");
    const second = await client.listMaterials({
      courseId: "d:alias",
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.materials).toEqual([material]);
    const urls = mock.mock.calls.map(([url]) => url);
    expect(urls[0]!.pathname).toBe("/v1/courses/d%3Aalias/courseWorkMaterials");
    expect(
      urls.every(
        (url) =>
          url.searchParams.get("courseWorkMaterialStates") === "PUBLISHED" &&
          url.searchParams.get("orderBy") === "updateTime desc",
      ),
    ).toBe(true);
  });
  it("returns published material details and refuses drafts", async () => {
    upstream();
    await expect(
      new ClassroomClient("secret").getMaterial("c1", "m1"),
    ).resolves.toEqual(material);
    upstream({ parent: { ...material, state: "DRAFT" } });
    await expect(
      new ClassroomClient("secret").getMaterial("c1", "m1"),
    ).rejects.toThrow("published");
  });
  it("validates attachment membership before reading Drive and pages text with provenance", async () => {
    const mock = upstream();
    const result = await new ClassroomClient("secret").getAttachmentContent({
      ...args,
      maxChars: 4,
    });
    expect(result).toMatchObject({
      text: "授業資料",
      nextOffset: 4,
      truncated: true,
      fileId: "attached-file",
      version: "1",
    });
    expect(mock.mock.calls.map(([url]) => url.hostname)).toEqual([
      "classroom.googleapis.com",
      "www.googleapis.com",
      "www.googleapis.com",
    ]);
    expect(mock.mock.calls[2]![0].searchParams.get("alt")).toBe("media");
    expect(JSON.stringify(result)).not.toContain("secret");
    const next = await new ClassroomClient("secret").getAttachmentContent({
      ...args,
      offset: 4,
    });
    expect(result.text + next.text).toBe("授業資料の本文です。");
    expect(next.truncated).toBe(false);
    expect(next.nextOffset).toBeUndefined();
  });
  it("also reads files attached to assignments", async () => {
    const mock = upstream();
    await new ClassroomClient("secret").getAttachmentContent({
      ...args,
      sourceType: "assignment",
      sourceId: "a1",
    });
    expect(mock.mock.calls[0]![0].pathname).toBe(
      "/v1/courses/c1/courseWork/a1",
    );
  });
  it("exports native Docs/Slides and warns that Sheets includes only the first sheet", async () => {
    for (const type of ["document", "presentation", "spreadsheet"]) {
      const mock = upstream({
        file: { mimeType: `application/vnd.google-apps.${type}` },
      });
      const result = await new ClassroomClient("secret").getAttachmentContent(
        args,
      );
      expect(mock.mock.calls[2]![0].pathname).toBe(
        "/drive/v3/files/attached-file/export",
      );
      expect(mock.mock.calls[2]![0].searchParams.get("mimeType")).toBe(
        type === "spreadsheet" ? "text/tab-separated-values" : "text/plain",
      );
      if (type === "spreadsheet")
        expect(result.warnings.join(" ")).toContain("first sheet");
    }
  });
  it("extracts a real PDF rather than returning base64", async () => {
    upstream({
      file: { mimeType: "application/pdf" },
      content: () => new Response(pdfFixture("Material PDF")),
    });
    const result = await new ClassroomClient("secret").getAttachmentContent(
      args,
    );
    expect(result.text).toContain("Material PDF");
    expect(result.warnings.join(" ")).toContain("OCR");
  });
  it("makes no Drive requests for missing indices, non-Drive links or unpublished parents", async () => {
    for (const parent of [
      { ...material, materials: [] },
      {
        ...material,
        materials: [{ link: { url: "http://169.254.169.254/" } }],
      },
      { ...material, state: "DRAFT" },
    ]) {
      const mock = upstream({ parent });
      await expect(
        new ClassroomClient("secret").getAttachmentContent(args),
      ).rejects.toThrow();
      expect(mock).toHaveBeenCalledOnce();
    }
  });
  it("stops before download for restricted, unsupported or oversized files", async () => {
    for (const file of [
      { capabilities: { canDownload: false } },
      { mimeType: "application/msword" },
      { size: String(MAX_FILE_BYTES + 1) },
    ]) {
      const mock = upstream({ file });
      await expect(
        new ClassroomClient("secret").getAttachmentContent(args),
      ).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(2);
    }
  });
  it("bounds actual streamed bytes without a Content-Length and cancels overflow", async () => {
    const cancel = vi.fn();
    upstream({
      content: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel,
          }),
        ),
    });
    await expect(
      new ClassroomClient("secret").getAttachmentContent(args),
    ).rejects.toThrow("5 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("sanitizes Drive denial errors, avoids retries and forbids redirects", async () => {
    const mock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return url.hostname === "classroom.googleapis.com"
        ? Response.json(material)
        : new Response("private upstream token", { status: 403 });
    });
    vi.stubGlobal("fetch", mock);
    await expect(
      new ClassroomClient("secret").getAttachmentContent(args),
    ).rejects.toThrow("Drive access denied");
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("reports invalid offsets, empty extraction and cancelled requests", async () => {
    upstream();
    await expect(
      new ClassroomClient("secret").getAttachmentContent({
        ...args,
        offset: 500,
      }),
    ).rejects.toThrow("offset");
    upstream({ content: () => new Response("") });
    const empty = await new ClassroomClient("secret").getAttachmentContent(
      args,
    );
    expect(empty.warnings.join(" ")).toContain(
      "does not mean the source is empty",
    );
    await expect(
      new ClassroomClient("secret", AbortSignal.abort()).getAttachmentContent(
        args,
      ),
    ).rejects.toThrow("cancelled");
  });
});
