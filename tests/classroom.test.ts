import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassroomClient, dueAt, inDueRange } from "../src/classroom";
import type { Assignment } from "../src/types";

const work = (id: string, day = 2): Assignment => ({
  id,
  courseId: "c1",
  title: id,
  dueDate: { year: 2026, month: 10, day },
  dueTime: { hours: 0 },
});
afterEach(() => vi.unstubAllGlobals());

describe("Classroom reads", () => {
  it("preserves midnight UTC and compares timezone offsets with an exclusive end", () => {
    expect(dueAt(work("a"))).toBe("2026-10-02T00:00:00.000Z");
    expect(
      inDueRange(
        work("a"),
        "2026-10-02T09:00:00+09:00",
        "2026-10-03T09:00:00+09:00",
      ),
    ).toBe(true);
    expect(inDueRange(work("a"), undefined, "2026-10-02T00:00:00Z")).toBe(
      false,
    );
    expect(
      inDueRange(
        { id: "x", courseId: "c", title: "No deadline" },
        "2026-10-01T00:00:00Z",
      ),
    ).toBe(false);
  });

  it("returns a continuation even when every item on a filtered page is excluded", async () => {
    const mock = vi.fn(async () =>
      Response.json({ courseWork: [work("old", 1)], nextPageToken: "page2" }),
    );
    vi.stubGlobal("fetch", mock);
    const result = await new ClassroomClient("secret").listAssignments({
      courseId: "c1",
      dueAfter: "2026-10-02T00:00:00Z",
    });
    expect(result.assignments).toEqual([]);
    expect(result.nextPageToken).toBe("page2");
    expect(
      new URL(mock.mock.calls[0]![0] as URL).searchParams.get(
        "courseWorkStates",
      ),
    ).toBe("PUBLISHED");
  });

  it("always restricts submissions to me and defaults to all coursework", async () => {
    const mock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", mock);
    await new ClassroomClient("secret").listMySubmissions({ courseId: "c1" });
    const url = new URL(mock.mock.calls[0]![0] as URL);
    expect(url.pathname).toBe("/v1/courses/c1/courseWork/-/studentSubmissions");
    expect(url.searchParams.get("userId")).toBe("me");
  });

  it("follows course, coursework, and submission pages and excludes completed items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(input);
        const next = url.searchParams.get("pageToken");
        if (url.pathname === "/v1/courses")
          return Response.json(
            next
              ? { courses: [{ id: "c2", name: "Empty course" }] }
              : {
                  courses: [{ id: "c1", name: "Math" }],
                  nextPageToken: "cpage",
                },
          );
        if (url.pathname.includes("c2")) return Response.json({});
        if (url.pathname.endsWith("studentSubmissions"))
          return Response.json(
            next
              ? {
                  studentSubmissions: [
                    { id: "s2", courseWorkId: "b", state: "TURNED_IN" },
                  ],
                }
              : {
                  studentSubmissions: [
                    { id: "s1", courseWorkId: "a", state: "CREATED" },
                  ],
                  nextPageToken: "spage",
                },
          );
        return Response.json(
          next
            ? { courseWork: [work("b"), work("unknown")] }
            : { courseWork: [work("a")], nextPageToken: "apage" },
        );
      }),
    );
    const result = await new ClassroomClient("secret").listDueAssignments({
      dueAfter: "2026-10-01T00:00:00Z",
      dueBefore: "2026-10-05T00:00:00Z",
    });
    expect(result.assignments.map((a) => a.id)).toEqual(["a", "unknown"]);
    expect(result.assignments[0]?.courseName).toBe("Math");
    expect(result.assignments[1]?.submissionState).toBe("UNKNOWN");
    expect(result.incomplete).toBe(false);
  });

  it("keeps assignments when submission reads fail and reports incomplete states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        String(url).includes("studentSubmissions")
          ? new Response("private error", { status: 403 })
          : Response.json({ courseWork: [work("a")] }),
      ),
    );
    const result = await new ClassroomClient("secret").listDueAssignments({
      courseId: "c1",
      dueAfter: "2026-10-01T00:00:00Z",
    });
    expect(result.assignments[0]?.submissionState).toBe("UNKNOWN");
    expect(result.incomplete).toBe(true);
    expect(result.warnings.join()).not.toContain("private error");
  });

  it("marks capped pagination as incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ courseWork: [], nextPageToken: "again" }),
      ),
    );
    const result = await new ClassroomClient("secret").listDueAssignments({
      courseId: "c1",
      dueAfter: "2026-10-01T00:00:00Z",
    });
    expect(result.incomplete).toBe(true);
    expect(result.warnings.join()).toContain("pagination limit");
  });

  it("does not leak upstream response text or credentials on API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret-token", { status: 401 })),
    );
    await expect(
      new ClassroomClient("secret-token").getAssignment("c1", "a"),
    ).rejects.toThrow("Reconnect");
  });

  it("rejects inverted ranges before making API calls", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(
      new ClassroomClient("secret").listAssignments({
        courseId: "c",
        dueAfter: "2026-10-03T00:00:00Z",
        dueBefore: "2026-10-01T00:00:00Z",
      }),
    ).rejects.toThrow("earlier");
    expect(mock).not.toHaveBeenCalled();
  });
});
