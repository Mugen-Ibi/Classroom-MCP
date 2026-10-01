import type { Assignment, Course, Submission } from "./types";

type Query = Record<string, string | number | undefined>;
interface Page<T> {
  items: T[];
  nextPageToken?: string;
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

  constructor(private readonly accessToken: string) {}

  private async get<T>(path: string, query: Query = {}): Promise<T> {
    if (this.remainingRequests-- <= 0)
      throw new ClassroomError(
        "Request limit reached. Narrow the date range or specify a courseId.",
      );
    const url = new URL(`https://classroom.googleapis.com/v1/${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ClassroomError(
        "Classroom is unavailable or timed out. Retry later.",
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "Google access expired or was revoked. Reconnect this MCP.",
        403: "Access denied. Check enrollment, Classroom API enablement, OAuth scopes, and your school's administrator policy.",
        404: "Course or assignment not found, or it is inaccessible.",
        429: "Classroom rate limit exceeded. Retry later.",
      };
      throw new ClassroomError(
        messages[response.status] ??
          `Classroom request failed (HTTP ${response.status}). Retry later.`,
      );
    }
    return response.json() as Promise<T>;
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
      const result = await load(pageToken);
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
    if ("nextPageToken" in courses && courses.nextPageToken)
      warnings.push(
        "Course pagination limit reached. Specify a courseId to search additional courses.",
      );
    const assignments: Array<
      Assignment & {
        courseName: string;
        dueAt: string | null;
        submission: Submission | null;
        submissionState: string;
      }
    > = [];
    for (const course of courses.items) {
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
        if (works.nextPageToken)
          warnings.push(
            `Course ${course.id}: assignment pagination limit reached.`,
          );
        if (!works.items.length) continue;
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
          if (submissions.nextPageToken)
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
    }
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
