import type { Assignment, Course, Submission } from "./types";

type Query = Record<string, string | number | undefined>;
interface Page<T> {
  items: T[];
  nextPageToken?: string;
  warning?: string;
}

type DueAssignment = Assignment & {
  courseName: string;
  dueAt: string | null;
  submission: Submission | null;
  submissionState: string;
};

const TIME_BUDGET_MS = 45_000;
const TIME_BUDGET_MESSAGE =
  "Classroom time budget reached. Specify a courseId or narrow the date range and retry.";

function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const delay = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export class ClassroomError extends Error {}

// Classroom dates and times are UTC, even when the UI displays local time.
export function dueAt(work: Assignment): string | null {
  if (!work.dueDate) return null;
  const { year, month, day } = work.dueDate;
  const { hours = 0, minutes = 0, seconds = 0, nanos = 0 } = work.dueTime ?? {};
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hours,
      minutes,
      seconds,
      Math.floor(nanos / 1e6),
    ),
  ).toISOString();
}

export function inDueRange(
  work: Assignment,
  after?: string,
  before?: string,
): boolean {
  const due = dueAt(work);
  if (!after && !before) return true;
  if (!due) return false;
  const time = Date.parse(due);
  return (
    (!after || time >= Date.parse(after)) &&
    (!before || time < Date.parse(before))
  );
}

export function validateRange(after?: string, before?: string): void {
  if (after && before && Date.parse(after) >= Date.parse(before))
    throw new ClassroomError("dueAfter must be earlier than dueBefore.");
}

export class ClassroomClient {
  private remainingRequests = 100;
  private readonly deadline = Date.now() + TIME_BUDGET_MS;

  constructor(private readonly accessToken: string) {}

  private async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(`https://classroom.googleapis.com/v1/${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      const remainingTime = this.deadline - Date.now();
      if (remainingTime <= 0) throw new ClassroomError(TIME_BUDGET_MESSAGE);
      // Retries consume the same request budget as initial attempts.
      if (this.remainingRequests-- <= 0)
        throw new ClassroomError(
          "Request limit reached. Narrow the date range or specify a courseId.",
        );
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          signal: AbortSignal.timeout(Math.min(15_000, remainingTime)),
        });
        // Await body consumption inside the retry boundary: it can time out too.
        if (response.ok) return (await response.json()) as T;
      } catch {
        response = undefined;
      }
      const messages: Record<number, string> = {
        401: "Google access expired or was revoked. Reconnect this MCP.",
        403: "Access denied. Check enrollment, Classroom API enablement, OAuth scopes, and your school's administrator policy.",
        404: "Course or assignment not found, or it is inaccessible.",
        429: "Classroom rate limit exceeded. Retry later.",
      };
      const message = response
        ? (messages[response.status] ??
          `Classroom request failed (HTTP ${response.status}). Retry later.`)
        : "Classroom is unavailable or timed out. Retry later.";
      const retryable =
        !response || [408, 429, 500, 502, 503, 504].includes(response.status);
      const retryAfter = retryAfterMs(
        response?.headers.get("Retry-After") ?? null,
      );
      // Discard error bodies without relaying Google's private error details.
      await response?.body?.cancel().catch(() => undefined);
      if (!retryable || attempt === 2) throw new ClassroomError(message);
      const delay = Math.max(
        1000 * 2 ** attempt + Math.floor(Math.random() * 250),
        retryAfter,
      );
      if (Date.now() + delay >= this.deadline)
        throw new ClassroomError(TIME_BUDGET_MESSAGE);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    throw new ClassroomError(TIME_BUDGET_MESSAGE);
  }

  private async page<T>(
    path: string,
    key: string,
    query: Query,
  ): Promise<Page<T>> {
    const data = await this.get<Record<string, unknown>>(path, query);
    return {
      items: (data[key] as T[] | undefined) ?? [],
      nextPageToken: data.nextPageToken as string | undefined,
    };
  }

  async listCourses(
    input: { pageSize?: number; pageToken?: string; courseState?: string } = {},
  ) {
    const result = await this.page<Course>("courses", "courses", {
      studentId: "me",
      courseStates: input.courseState ?? "ACTIVE",
      pageSize: input.pageSize ?? 100,
      pageToken: input.pageToken,
    });
    return { courses: result.items, nextPageToken: result.nextPageToken };
  }

  async listAssignments(input: {
    courseId: string;
    pageSize?: number;
    pageToken?: string;
    dueAfter?: string;
    dueBefore?: string;
  }) {
    validateRange(input.dueAfter, input.dueBefore);
    const result = await this.page<Assignment>(
      `courses/${encodeURIComponent(input.courseId)}/courseWork`,
      "courseWork",
      {
        courseWorkStates: "PUBLISHED",
        pageSize: input.pageSize ?? 100,
        pageToken: input.pageToken,
      },
    );
    return {
      assignments: result.items
        .filter((work) => inDueRange(work, input.dueAfter, input.dueBefore))
        .map((work) => ({ ...work, dueAt: dueAt(work) })),
      nextPageToken: result.nextPageToken,
      // Filtering is per API page: an empty result can still have another page.
      filteredPage: Boolean(input.dueAfter || input.dueBefore),
    };
  }

  async getAssignment(courseId: string, assignmentId: string) {
    const work = await this.get<Assignment>(
      `courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(assignmentId)}`,
    );
    return { ...work, dueAt: dueAt(work) };
  }

  async listMySubmissions(input: {
    courseId: string;
    assignmentId?: string;
    pageSize?: number;
    pageToken?: string;
  }) {
    const result = await this.page<Submission>(
      `courses/${encodeURIComponent(input.courseId)}/courseWork/${encodeURIComponent(input.assignmentId ?? "-")}/studentSubmissions`,
      "studentSubmissions",
      {
        userId: "me",
        pageSize: input.pageSize ?? 100,
        pageToken: input.pageToken,
      },
    );
    return { submissions: result.items, nextPageToken: result.nextPageToken };
  }

  private async collect<T>(
    load: (pageToken?: string) => Promise<Page<T>>,
  ): Promise<Page<T>> {
    const items: T[] = [];
    let pageToken: string | undefined;
    // Bound upstream work; report incomplete results rather than silently dropping pages.
    for (let page = 0; page < 10; page++) {
      let result: Page<T>;
      try {
        result = await load(pageToken);
      } catch (error) {
        if (!(error instanceof ClassroomError) || page === 0) throw error;
        return { items, nextPageToken: pageToken, warning: error.message };
      }
      items.push(...result.items);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    return { items, nextPageToken: pageToken };
  }

  async listDueAssignments(input: {
    courseId?: string;
    dueAfter?: string;
    dueBefore?: string;
    pendingOnly?: boolean;
  }) {
    const after = input.dueAfter ?? new Date().toISOString();
    const before =
      input.dueBefore ??
      new Date(Date.parse(after) + 7 * 86400_000).toISOString();
    validateRange(after, before);
    const warnings: string[] = [];
    const courses = input.courseId
      ? { items: [{ id: input.courseId, name: input.courseId } as Course] }
      : await this.collect<Course>(async (pageToken) => {
          const result = await this.listCourses({ pageToken });
          return { items: result.courses, nextPageToken: result.nextPageToken };
        });
    if ("warning" in courses && courses.warning)
      warnings.push(`Course listing: ${courses.warning}`);
    else if ("nextPageToken" in courses && courses.nextPageToken)
      warnings.push(
        "Course pagination limit reached. Specify a courseId to search additional courses.",
      );
    const results: Array<{ assignments: DueAssignment[]; warnings: string[] }> =
      [];
    const loadCourse = async (course: Course) => {
      const assignments: DueAssignment[] = [];
      const warnings: string[] = [];
      try {
        const works = await this.collect<Assignment>(async (pageToken) => {
          const result = await this.listAssignments({
            courseId: course.id,
            pageToken,
            dueAfter: after,
            dueBefore: before,
          });
          return {
            items: result.assignments,
            nextPageToken: result.nextPageToken,
          };
        });
        if (works.warning)
          warnings.push(`Course ${course.id}: ${works.warning}`);
        else if (works.nextPageToken)
          warnings.push(
            `Course ${course.id}: assignment pagination limit reached.`,
          );
        if (!works.items.length) return { assignments, warnings };
        let submissions: Page<Submission> = { items: [] };
        try {
          submissions = await this.collect<Submission>(async (pageToken) => {
            const result = await this.listMySubmissions({
              courseId: course.id,
              pageToken,
            });
            return {
              items: result.submissions,
              nextPageToken: result.nextPageToken,
            };
          });
          if (submissions.warning)
            warnings.push(
              `Course ${course.id}: ${submissions.warning} Missing states are UNKNOWN.`,
            );
          else if (submissions.nextPageToken)
            warnings.push(
              `Course ${course.id}: submission pagination limit reached. Missing states are UNKNOWN.`,
            );
        } catch (error) {
          if (!(error instanceof ClassroomError)) throw error;
          warnings.push(
            `Course ${course.id}: ${error.message} Submission states are UNKNOWN.`,
          );
        }
        const byWork = new Map(
          submissions.items.map((s) => [s.courseWorkId, s]),
        );
        for (const work of works.items) {
          const submission = byWork.get(work.id) ?? null;
          const state = submission?.state ?? "UNKNOWN";
          if (
            input.pendingOnly !== false &&
            ["TURNED_IN", "RETURNED"].includes(state)
          )
            continue;
          assignments.push({
            ...work,
            courseName: course.name,
            dueAt: dueAt(work),
            submission,
            submissionState: state,
          });
        }
      } catch (error) {
        if (!(error instanceof ClassroomError)) throw error;
        warnings.push(`Course ${course.id}: ${error.message}`);
      }
      return { assignments, warnings };
    };
    let nextCourse = 0;
    // Keep pagination sequential within each course; overlap at most three courses.
    await Promise.all(
      Array.from({ length: Math.min(3, courses.items.length) }, async () => {
        while (nextCourse < courses.items.length) {
          const index = nextCourse++;
          results[index] = await loadCourse(courses.items[index]!);
        }
      }),
    );
    const assignments = results.flatMap((result) => result.assignments);
    warnings.push(...results.flatMap((result) => result.warnings));
    assignments.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    return {
      assignments,
      dueAfter: after,
      dueBefore: before,
      pendingOnly: input.pendingOnly !== false,
      incomplete: warnings.length > 0,
      warnings,
    };
  }
}
