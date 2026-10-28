import type { Assignment, Course, CourseMaterial, Submission } from "./types";
import { extractDocument, MAX_FILE_BYTES } from "./documents";

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
// Stay below Workers Free's 50 external subrequests, leaving room for middleware.
const REQUEST_BUDGET = 45;
const TIME_BUDGET_MESSAGE =
  "Classroom time budget reached. Specify a courseId or narrow the date range and retry.";
// Aggregate reads keep descriptions and attachment references, but omit grading/history metadata.
const COURSE_FIELDS = "nextPageToken,courses(id,name)";
const WORK_FIELDS =
  "nextPageToken,courseWork(id,courseId,title,description,dueDate,dueTime,alternateLink,workType,materials)";
const SUBMISSION_FIELDS =
  "nextPageToken,studentSubmissions(id,courseId,courseWorkId,userId,state,late,alternateLink,assignmentSubmission,shortAnswerSubmission,multipleChoiceSubmission)";

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
  private remainingRequests = REQUEST_BUDGET;
  private readonly deadline = Date.now() + TIME_BUDGET_MS;

  constructor(
    private readonly accessToken: string,
    private readonly signal?: AbortSignal,
  ) {}

  private checkCancelled(): void {
    if (this.signal?.aborted)
      throw new ClassroomError("Classroom request was cancelled.");
  }

  private async wait(delay: number): Promise<void> {
    this.checkCancelled();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => this.signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delay);
      const abort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new ClassroomError("Classroom request was cancelled."));
      };
      this.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async read<T>(
    path: string,
    query: Query,
    consume: (response: Response) => Promise<T>,
    api: "Classroom" | "Drive" = "Classroom",
  ): Promise<T> {
    const base =
      api === "Classroom"
        ? "https://classroom.googleapis.com/v1/"
        : "https://www.googleapis.com/drive/v3/";
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      this.checkCancelled();
      const remainingTime = this.deadline - Date.now();
      if (remainingTime <= 0) throw new ClassroomError(TIME_BUDGET_MESSAGE);
      // Retries consume the same request budget as initial attempts.
      if (this.remainingRequests-- <= 0)
        throw new ClassroomError(
          "Request limit reached. Narrow the date range or specify a courseId.",
        );
      let response: Response | undefined;
      try {
        const timeout = AbortSignal.timeout(Math.min(15_000, remainingTime));
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          // Workers supports manual/follow. Reject 3xx below without forwarding credentials.
          redirect: "manual",
          signal: this.signal
            ? AbortSignal.any([timeout, this.signal])
            : timeout,
        });
        // Await body consumption inside the retry boundary: it can time out too.
        if (response.ok) return await consume(response);
      } catch (error) {
        if (error instanceof ClassroomError) throw error;
        this.checkCancelled();
        response = undefined;
      }
      const messages: Record<number, string> = {
        401: "Google access expired or was revoked. Reconnect this MCP.",
        403:
          api === "Classroom"
            ? "Access denied. Check enrollment, Classroom API enablement, OAuth scopes, and your school's administrator policy."
            : "Drive access denied. Check file sharing, download restrictions, Drive API enablement, OAuth scopes, and administrator policy. Reconnect for new attachment permissions.",
        404:
          api === "Classroom"
            ? "Course, assignment or material not found, or it is inaccessible."
            : "Attached Drive file not found, or it is inaccessible.",
        429: `${api} rate limit exceeded. Retry later.`,
      };
      const message = response
        ? (messages[response.status] ??
          `${api} request failed (HTTP ${response.status}). Retry later.`)
        : `${api} is unavailable or timed out. Retry later.`;
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
      await this.wait(delay);
    }
    throw new ClassroomError(TIME_BUDGET_MESSAGE);
  }

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.read(
      path,
      query,
      async (response) => (await response.json()) as T,
    );
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

  async listMaterials(input: {
    courseId: string;
    pageSize?: number;
    pageToken?: string;
  }) {
    const result = await this.page<CourseMaterial>(
      `courses/${encodeURIComponent(input.courseId)}/courseWorkMaterials`,
      "courseWorkMaterial",
      {
        courseWorkMaterialStates: "PUBLISHED",
        orderBy: "updateTime desc",
        pageSize: input.pageSize ?? 100,
        pageToken: input.pageToken,
      },
    );
    return { materials: result.items, nextPageToken: result.nextPageToken };
  }

  async getMaterial(courseId: string, materialId: string) {
    const material = await this.get<CourseMaterial>(
      `courses/${encodeURIComponent(courseId)}/courseWorkMaterials/${encodeURIComponent(materialId)}`,
    );
    if (material.state !== "PUBLISHED")
      throw new ClassroomError(
        "Only published Classroom materials can be read.",
      );
    return material;
  }

  async getAttachmentContent(input: {
    courseId: string;
    sourceType: "material" | "assignment";
    sourceId: string;
    attachmentIndex: number;
    offset?: number;
    maxChars?: number;
  }) {
    this.checkCancelled();
    // Re-read the parent on every call. Never accept arbitrary file IDs or URLs.
    const parent =
      input.sourceType === "material"
        ? await this.getMaterial(input.courseId, input.sourceId)
        : await this.getAssignment(input.courseId, input.sourceId);
    if (parent.state !== "PUBLISHED")
      throw new ClassroomError(
        "Only attachments of published Classroom items can be read.",
      );
    const attachment = parent.materials?.[input.attachmentIndex];
    if (!attachment)
      throw new ClassroomError(
        "Attachment index not found. Read the source item again.",
      );
    const fileId = attachment.driveFile?.driveFile?.id;
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId))
      throw new ClassroomError(
        "This attachment is not a Drive file. External links, YouTube videos and Forms are references only.",
      );
    const path = `files/${encodeURIComponent(fileId)}`;
    const file = await this.read<{
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
      version?: string;
      capabilities?: { canDownload?: boolean };
    }>(
      path,
      {
        fields:
          "id,name,mimeType,size,modifiedTime,version,capabilities(canDownload)",
        supportsAllDrives: "true",
      },
      async (response) => await response.json(),
      "Drive",
    );
    if (file.capabilities?.canDownload !== true)
      throw new ClassroomError(
        "Downloading this attachment is restricted by its owner or administrator.",
      );
    if (
      file.size !== undefined &&
      (!/^\d+$/.test(file.size) || Number(file.size) > MAX_FILE_BYTES)
    )
      throw new ClassroomError("Attachment exceeds the 5 MiB file limit.");
    const exports: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.presentation": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/tab-separated-values",
    };
    const exportedMime = exports[file.mimeType];
    const mimeType = exportedMime ?? file.mimeType;
    if (
      !exportedMime &&
      ![
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/tab-separated-values",
      ].includes(mimeType)
    )
      throw new ClassroomError(
        "Unsupported attachment format. Supported: PDF, DOCX, PPTX, Google Docs/Slides/Sheets and UTF-8 text. Open the original for other formats.",
      );
    const bytes = await this.read(
      exportedMime ? `${path}/export` : path,
      exportedMime
        ? { mimeType: exportedMime }
        : { alt: "media", supportsAllDrives: "true" },
      async (response) => {
        if (Number(response.headers.get("Content-Length")) > MAX_FILE_BYTES) {
          await response.body?.cancel();
          throw new ClassroomError("Attachment exceeds the 5 MiB file limit.");
        }
        if (!response.body) return new Uint8Array();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            this.checkCancelled();
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_FILE_BYTES) {
              await reader.cancel();
              throw new ClassroomError(
                "Attachment exceeds the 5 MiB file limit.",
              );
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const buffer = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, position);
          position += chunk.byteLength;
        }
        return buffer;
      },
      "Drive",
    );
    this.checkCancelled();
    let extracted: Awaited<ReturnType<typeof extractDocument>>;
    try {
      extracted = await extractDocument(bytes, mimeType, this.signal);
    } catch {
      this.checkCancelled();
      throw new ClassroomError(
        "Unable to extract attachment text. The file may be encrypted, malformed, or exceed document limits. Open the original file.",
      );
    }
    this.checkCancelled();
    if (Date.now() >= this.deadline)
      throw new ClassroomError(TIME_BUDGET_MESSAGE);
    const offset = input.offset ?? 0;
    const maxChars = input.maxChars ?? 12_000;
    if (offset > extracted.text.length)
      throw new ClassroomError(
        "Text offset is beyond this document. Restart from offset 0; the file may have changed.",
      );
    const end = Math.min(extracted.text.length, offset + maxChars);
    const warnings = [...extracted.warnings];
    if (exportedMime)
      warnings.push(
        "Google Workspace text export omits images, charts, visual layout and embedded content. Verify these in the original file.",
      );
    if (file.mimeType === "application/vnd.google-apps.spreadsheet")
      warnings.push(
        "Google Sheets export includes only the first sheet; other sheets were not read.",
      );
    if (!extracted.text.trim())
      warnings.push(
        "No text was extracted. This does not mean the source is empty. Scanned images require OCR, which is not provided.",
      );
    return {
      courseId: input.courseId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      attachmentIndex: input.attachmentIndex,
      fileId,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      version: file.version,
      sourceUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
      text: extracted.text.slice(offset, end),
      offset,
      totalChars: extracted.text.length,
      nextOffset: end < extracted.text.length ? end : undefined,
      truncated: end < extracted.text.length,
      warnings,
    };
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
    complete?: () => boolean,
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
      // A continuation is irrelevant once all requested submission states are known.
      if (complete?.()) return { items };
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
          return this.page<Course>("courses", "courses", {
            studentId: "me",
            courseStates: "ACTIVE",
            pageSize: 100,
            pageToken,
            fields: COURSE_FIELDS,
          });
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
          const result = await this.page<Assignment>(
            `courses/${encodeURIComponent(course.id)}/courseWork`,
            "courseWork",
            {
              courseWorkStates: "PUBLISHED",
              pageSize: 100,
              pageToken,
              fields: WORK_FIELDS,
            },
          );
          return {
            items: result.items.filter((work) =>
              inDueRange(work, after, before),
            ),
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
        const missing = new Set(works.items.map((work) => work.id));
        try {
          submissions = await this.collect<Submission>(
            async (pageToken) => {
              const result = await this.page<Submission>(
                `courses/${encodeURIComponent(course.id)}/courseWork/-/studentSubmissions`,
                "studentSubmissions",
                {
                  userId: "me",
                  pageSize: 100,
                  pageToken,
                  fields: SUBMISSION_FIELDS,
                },
              );
              return {
                ...result,
                items: result.items.filter((s) =>
                  missing.delete(s.courseWorkId),
                ),
              };
            },
            () => missing.size === 0,
          );
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
