// Reproducible local comparison; no credentials or real Google requests.
// esbuild is supplied by the repository's locked Wrangler development dependencies.
import { transform } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";

const baseline = process.argv[2] ?? "1b053fa";
const sources = {
  baseline: execFileSync("git", ["show", `${baseline}:src/classroom.ts`], {
    encoding: "utf8",
  }),
  current: readFileSync("src/classroom.ts", "utf8"),
};
const courses = Array.from({ length: 6 }, (_, index) => ({
  id: `c${index}`,
  name: `Course ${index}`,
  description: "Course details",
  section: "A",
}));
const courseWork = (courseId) =>
  Array.from({ length: 200 }, (_, index) => ({
    id: `w${index}`,
    courseId,
    title: `Task ${index}`,
    description: "Read materials and submit slides.",
    dueDate: { year: 2026, month: 10, day: index < 2 ? 2 : 20 },
    dueTime: { hours: 12 },
    workType: "ASSIGNMENT",
    materials: [
      { link: { url: "https://example.com/material", title: "Material" } },
    ],
    creationTime: "2026-09-01T00:00:00Z",
    updateTime: "2026-09-15T00:00:00Z",
    maxPoints: 100,
    gradeCategory: { id: "category", name: "Homework", weight: 25 },
    assigneeMode: "ALL_STUDENTS",
  }));
const submissions = (courseId) =>
  Array.from({ length: 300 }, (_, index) => ({
    id: `s${index}`,
    courseId,
    courseWorkId: `w${index}`,
    userId: "student",
    state: "CREATED",
    late: false,
    assignedGrade: 0,
    draftGrade: 0,
    submissionHistory: Array.from({ length: 4 }, () => ({
      stateHistory: {
        state: "CREATED",
        stateTimestamp: "2026-09-01T00:00:00Z",
        actorUserId: "student",
      },
    })),
  }));
const page = (items, key, offset) => ({
  [key]: items.slice(offset, offset + 100),
  ...(offset + 100 < items.length
    ? { nextPageToken: String(offset + 100) }
    : {}),
});
function project(data, fields) {
  if (!fields) return data;
  const [, key, names] = fields.match(/^nextPageToken,(\w+)\(([^)]+)\)$/);
  return {
    ...("nextPageToken" in data ? { nextPageToken: data.nextPageToken } : {}),
    [key]: data[key].map((item) =>
      Object.fromEntries(
        names
          .split(",")
          .filter((name) => name in item)
          .map((name) => [name, item[name]]),
      ),
    ),
  };
}
const originalFetch = globalThis.fetch;
const measurements = {};
try {
  for (const [name, source] of Object.entries(sources)) {
    const { code } = await transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2022",
    });
    const { ClassroomClient } = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    const runs = [];
    for (let run = 0; run < 5; run++) {
      let calls = 0;
      let bytes = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        const offset = Number(url.searchParams.get("pageToken") ?? 0);
        const courseId = url.pathname.split("/")[3];
        const data =
          url.pathname === "/v1/courses"
            ? { courses }
            : url.pathname.endsWith("studentSubmissions")
              ? page(submissions(courseId), "studentSubmissions", offset)
              : page(courseWork(courseId), "courseWork", offset);
        const body = JSON.stringify(
          project(data, url.searchParams.get("fields")),
        );
        calls++;
        bytes += Buffer.byteLength(body);
        // Fixed mock latency; this is not a measurement of Google's live service.
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response(body, {
          headers: { "Content-Type": "application/json" },
        });
      };
      const start = performance.now();
      const result = await new ClassroomClient("mock-token").listDueAssignments(
        {
          dueAfter: "2026-10-01T00:00:00Z",
          dueBefore: "2026-10-08T00:00:00Z",
        },
      );
      const elapsedMs = performance.now() - start;
      assert.equal(result.incomplete, false);
      assert.equal(result.assignments.length, 12);
      assert(
        result.assignments.every(
          (a) =>
            a.submissionState === "CREATED" &&
            a.materials[0].link.url === "https://example.com/material",
        ),
      );
      runs.push({ calls, bytes, elapsedMs });
    }
    assert(
      runs.every((r) => r.calls === runs[0].calls && r.bytes === runs[0].bytes),
    );
    measurements[name] = {
      apiCalls: runs[0].calls,
      upstreamBytes: runs[0].bytes,
      medianElapsedMs: Math.round(
        runs.map((r) => r.elapsedMs).sort((a, b) => a - b)[2],
      ),
    };
  }
} finally {
  globalThis.fetch = originalFetch;
}
const bundle = readFileSync("dist/index.js");
console.log(
  JSON.stringify(
    {
      fixture:
        "6 courses; 200 coursework and 300 submissions per course; 2 target deadlines per course, whose states are on submission page 1; 15ms mock latency; median of 5 runs",
      baselineRef: baseline,
      ...measurements,
      currentBundle: {
        rawBytes: bundle.length,
        gzipBytes: gzipSync(bundle).length,
      },
    },
    null,
    2,
  ),
);
