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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useRetryClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
}

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

  it("retries transient network failures twice with exponential backoff", async () => {
    useRetryClock();
    const times: number[] = [];
    const mock = vi.fn(async () => {
      times.push(Date.now());
      if (times.length < 3)
        throw new TypeError("private-token network failure");
      return Response.json({ courses: [{ id: "c1", name: "Math" }] });
    });
    vi.stubGlobal("fetch", mock);
    const result = new ClassroomClient("secret").listCourses();
    const assertion = expect(result).resolves.toMatchObject({
      courses: [{ id: "c1" }],
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(times.map((time) => time - times[0]!)).toEqual([0, 1000, 3000]);
  });

  it("honors Retry-After seconds and HTTP dates on 429 and 503", async () => {
    useRetryClock();
    const start = Date.now();
    const times: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        times.push(Date.now() - start);
        if (times.length === 1)
          return new Response("private error", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        if (times.length === 2)
          return new Response("private error", {
            status: 503,
            headers: { "Retry-After": new Date(start + 5000).toUTCString() },
          });
        return Response.json({ courses: [] });
      }),
    );
    const assertion = expect(
      new ClassroomClient("secret").listCourses(),
    ).resolves.toMatchObject({ courses: [] });
    await vi.runAllTimersAsync();
    await assertion;
    expect(times).toEqual([0, 2000, 5000]);
  });

  it.each([400, 401, 403, 404, 501])(
    "does not retry HTTP %i",
    async (status) => {
      const mock = vi.fn(async () => new Response("private-token", { status }));
      vi.stubGlobal("fetch", mock);
      await expect(
        new ClassroomClient("secret").listCourses(),
      ).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  it("stops after three failed attempts and hides upstream error bodies", async () => {
    useRetryClock();
    const mock = vi.fn(
      async () => new Response("private-token", { status: 500 }),
    );
    vi.stubGlobal("fetch", mock);
    const assertion = expect(
      new ClassroomClient("secret").listCourses(),
    ).rejects.toThrow("Classroom request failed (HTTP 500)");
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("retries a response-body timeout after successful response headers", async () => {
    useRetryClock();
    const mock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new DOMException("private-token", "TimeoutError");
        },
      })
      .mockResolvedValueOnce(Response.json({ courses: [] }));
    vi.stubGlobal("fetch", mock);
    const assertion = expect(
      new ClassroomClient("secret").listCourses(),
    ).resolves.toMatchObject({ courses: [] });
    await vi.runAllTimersAsync();
    await assertion;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("overlaps at most three courses and keeps deterministic deadline ordering", async () => {
    useRetryClock();
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(input);
        if (url.pathname === "/v1/courses")
          return Response.json({
            courses: Array.from({ length: 7 }, (_, index) => ({
              id: `c${index}`,
              name: `Course ${index}`,
            })),
          });
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        const courseId = url.pathname.split("/")[3]!;
        return url.pathname.endsWith("studentSubmissions")
          ? Response.json({
              studentSubmissions: [
                {
                  id: `s-${courseId}`,
                  courseWorkId: courseId,
                  state: "CREATED",
                },
              ],
            })
          : Response.json({ courseWork: [{ ...work(courseId), courseId }] });
      }),
    );
    const result = new ClassroomClient("secret").listDueAssignments({
      dueAfter: "2026-10-01T00:00:00Z",
    });
    await vi.runAllTimersAsync();
    const actual = await result;
    expect(maxActive).toBe(3);
    expect(actual.assignments.map((assignment) => assignment.id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `c${index}`),
    );
    expect(actual.incomplete).toBe(false);
  });

  it("retains earlier assignment and submission pages when a later page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(input);
        if (url.searchParams.has("pageToken"))
          return new Response("private-token", { status: 403 });
        if (url.pathname.endsWith("studentSubmissions"))
          return Response.json({
            studentSubmissions: [
              { id: "s1", courseWorkId: "a", state: "CREATED" },
            ],
            nextPageToken: "submissions2",
          });
        return Response.json({
          courseWork: [work("a"), work("b")],
          nextPageToken: "assignments2",
        });
      }),
    );
    const actual = await new ClassroomClient("secret").listDueAssignments({
      courseId: "c1",
      dueAfter: "2026-10-01T00:00:00Z",
    });
    expect(
      actual.assignments.map((assignment) => assignment.submissionState),
    ).toEqual(["CREATED", "UNKNOWN"]);
    expect(actual.incomplete).toBe(true);
    expect(actual.warnings).toHaveLength(2);
    expect(actual.warnings.join()).not.toContain("private-token");
  });

  it("bounds long Retry-After waits and returns already-read assignments as UNKNOWN", async () => {
    useRetryClock();
    const mock = vi.fn(async (input: URL) =>
      String(input).includes("studentSubmissions")
        ? new Response("private-token", {
            status: 429,
            headers: { "Retry-After": "120" },
          })
        : Response.json({ courseWork: [work("a")] }),
    );
    vi.stubGlobal("fetch", mock);
    const actual = await new ClassroomClient("secret").listDueAssignments({
      courseId: "c1",
      dueAfter: "2026-10-01T00:00:00Z",
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(actual.assignments[0]?.submissionState).toBe("UNKNOWN");
    expect(actual.incomplete).toBe(true);
    expect(actual.warnings.join()).toContain("time budget");
  });

  it("stops API work at the shared deadline, including response-body time", async () => {
    useRetryClock();
    const mock = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 46_000);
      throw new DOMException("private-token", "TimeoutError");
    });
    vi.stubGlobal("fetch", mock);
    await expect(new ClassroomClient("secret").listCourses()).rejects.toThrow(
      "time budget",
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("counts retry attempts toward the shared 100-request budget", async () => {
    useRetryClock();
    const mock = vi.fn(
      async () => new Response("private-token", { status: 503 }),
    );
    vi.stubGlobal("fetch", mock);
    const client = new ClassroomClient("secret");
    // Zero time between attempts lets the test isolate the request cap.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let index = 0; index < 34; index++) {
      const assertion = expect(client.listCourses()).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    }
    expect(mock).toHaveBeenCalledTimes(100);
  });
});
