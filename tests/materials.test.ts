import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassroomClient } from "../src/classroom";

const material = {
  id: "m1",
  courseId: "c1",
  title: "配布資料",
  state: "PUBLISHED",
  description: "今週の資料",
  materials: [
    { driveFile: { driveFile: { id: "attached-file", title: "Lecture.pdf" } } },
  ],
};
const args = {
  courseId: "c1",
  sourceType: "material" as const,
  sourceId: "m1",
  attachmentIndex: 0,
};
afterEach(() => vi.unstubAllGlobals());

function upstream(parent: object = material) {
  const mock = vi.fn(async (url: URL) => {
    // Simulate the administrator block. Reference retrieval must never hit Drive.
    if (url.hostname !== "classroom.googleapis.com")
      throw new Error("Drive blocked by administrator");
    return Response.json(parent);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Classroom materials and Google Drive plugin handoff", () => {
  it("preserves continuation on empty material pages and uses the singular response key", async () => {
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
    expect(first).toEqual({ materials: [], nextPageToken: "next" });
    expect(
      (
        await client.listMaterials({
          courseId: "d:alias",
          pageSize: 2,
          pageToken: first.nextPageToken,
        })
      ).materials,
    ).toEqual([material]);
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
  it("returns published details and refuses drafts", async () => {
    upstream();
    await expect(
      new ClassroomClient("secret").getMaterial("c1", "m1"),
    ).resolves.toEqual(material);
    upstream({ ...material, state: "DRAFT" });
    await expect(
      new ClassroomClient("secret").getMaterial("c1", "m1"),
    ).rejects.toThrow("published");
  });
  it("returns plugin actions after one Classroom request despite the Drive policy block", async () => {
    const mock = upstream();
    const result = await new ClassroomClient(
      "private-google-token",
    ).getAttachmentReference(args, "student@example.test");
    expect(result).toMatchObject({
      ...args,
      sourceTitle: "配布資料",
      contentFetched: false,
      fileId: "attached-file",
      title: "Lecture.pdf",
      url: "https://drive.google.com/file/d/attached-file/view",
      retrieval: {
        provider: "google_drive_plugin",
        status: "requires_client_action",
        performed: false,
        accountEmail: "student@example.test",
        metadata: { action: "get_file_metadata", fileId: "attached-file" },
        text: {
          action: "fetch",
          url: "https://drive.google.com/file/d/attached-file/view",
        },
        file: {
          action: "fetch",
          url: "https://drive.google.com/file/d/attached-file/view",
          download_raw_file: true,
          include_base64: false,
        },
      },
    });
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("nextOffset");
    expect(JSON.stringify(result)).not.toContain("private-google-token");
    expect(JSON.stringify(result)).not.toContain("link_id");
    expect(mock).toHaveBeenCalledOnce();
  });
  it("resolves assignment attachments without a Drive scope", async () => {
    const mock = upstream();
    const result = await new ClassroomClient("secret").getAttachmentReference({
      ...args,
      sourceType: "assignment",
      sourceId: "a1",
    });
    expect(mock.mock.calls[0]![0].pathname).toBe(
      "/v1/courses/c1/courseWork/a1",
    );
    expect(result.retrieval.provider).toBe("google_drive_plugin");
    expect(mock).toHaveBeenCalledOnce();
  });
  it("preserves the index when an external link precedes the Drive attachment", async () => {
    upstream({
      ...material,
      materials: [
        { link: { url: "https://example.test/" } },
        ...material.materials,
      ],
    });
    expect(
      (
        await new ClassroomClient("secret").getAttachmentReference({
          ...args,
          attachmentIndex: 1,
        })
      ).fileId,
    ).toBe("attached-file");
  });
  it("returns non-Drive attachments as references without promising Drive retrieval", async () => {
    for (const attachment of [
      { link: { url: "https://example.test/", title: "External" } },
      {
        youtubeVideo: {
          id: "video",
          alternateLink: "https://youtube.com/watch?v=video",
        },
      },
      { form: { formUrl: "https://docs.google.com/forms/d/form/viewform" } },
    ]) {
      const mock = upstream({ ...material, materials: [attachment] });
      const result = await new ClassroomClient("secret").getAttachmentReference(
        args,
      );
      expect(result).toMatchObject({
        contentFetched: false,
        attachment,
        retrieval: {
          provider: "external_reference",
          status: "reference_only",
          performed: false,
        },
      });
      expect(result).not.toHaveProperty("fileId");
      expect(mock).toHaveBeenCalledOnce();
    }
  });
  it("preserves a resource key from a Google URL for the same file", async () => {
    upstream({
      ...material,
      materials: [
        {
          driveFile: {
            driveFile: {
              id: "attached-file",
              alternateLink:
                "https://drive.google.com/file/d/attached-file/view?resourcekey=valid-key&usp=drive_web",
            },
          },
        },
      ],
    });
    expect(
      (await new ClassroomClient("secret").getAttachmentReference(args)).url,
    ).toBe(
      "https://drive.google.com/file/d/attached-file/view?resourcekey=valid-key",
    );
  });
  it("does not forward untrusted hosts, credentials, mismatched IDs or arbitrary query parameters", async () => {
    for (const alternateLink of [
      "https://evil.test/file/d/attached-file/view?resourcekey=key",
      "https://drive.google.com/file/d/other/view?resourcekey=key",
      "https://user:pass@drive.google.com/file/d/attached-file/view?resourcekey=key",
      "http://drive.google.com/file/d/attached-file/view?resourcekey=key",
      "https://drive.google.com/file/d/attached-file/view?redirect=https://evil.test",
      "not a URL",
    ]) {
      upstream({
        ...material,
        materials: [
          { driveFile: { driveFile: { id: "attached-file", alternateLink } } },
        ],
      });
      expect(
        (await new ClassroomClient("secret").getAttachmentReference(args)).url,
      ).toBe("https://drive.google.com/file/d/attached-file/view");
    }
  });
  it("rejects missing attachments, unpublished parents and invalid file IDs", async () => {
    for (const parent of [
      { ...material, materials: [] },
      { ...material, state: "DRAFT" },
      {
        ...material,
        materials: [{ driveFile: { driveFile: { id: "../escape" } } }],
      },
      { ...material, materials: [{ driveFile: { driveFile: {} } }] },
    ]) {
      const mock = upstream(parent);
      await expect(
        new ClassroomClient("secret").getAttachmentReference(args),
      ).rejects.toThrow();
      expect(mock).toHaveBeenCalledOnce();
    }
  });
  it("keeps cancellation and sanitized Classroom denial behavior", async () => {
    const mock = upstream();
    await expect(
      new ClassroomClient("secret", AbortSignal.abort()).getAttachmentReference(
        args,
      ),
    ).rejects.toThrow("cancelled");
    expect(mock).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private upstream detail", { status: 403 }),
      ),
    );
    await expect(
      new ClassroomClient("secret").getAttachmentReference(args),
    ).rejects.toThrow("Access denied");
  });
});
