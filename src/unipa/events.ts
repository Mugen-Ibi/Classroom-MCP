import { z } from "zod";
import { digest } from "./notices";
import { classifyImportance, type ImportancePolicy } from "./importance";
import { UNIPA_PORTAL, type Snapshot } from "./types";

const noticeIdSchema = z.string().regex(/^[a-f0-9]{64}:[1-9]\d{0,3}$/);
const noticeSchema = z
  .object({
    id: noticeIdSchema,
    source: z.literal("unipa"),
    title: z.string().min(1).max(2000),
    category: z.string().max(256),
    sender: z.string().max(256),
    postedDate: z.iso.date(),
    unread: z.boolean().nullable(),
    important: z.boolean(),
    officialUrl: z.literal(UNIPA_PORTAL),
  })
  .strict();
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    fetchedAt: z.iso.datetime(),
    totalCount: z.number().int().min(0).max(1000),
    complete: z.literal(true),
    notices: z.array(noticeSchema).max(1000),
  })
  .refine(
    (s) =>
      s.totalCount === s.notices.length &&
      new Set(s.notices.map((n) => n.id)).size === s.notices.length,
  );
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const payloadSchema = z
  .object({
    noticeId: noticeIdSchema,
    title: z.string().min(1).max(2000),
    category: z.string().max(256),
    sender: z.string().max(256),
    postedDate: z.iso.date(),
    officialUrl: z.literal(UNIPA_PORTAL),
    unreadAtDetection: z.literal(true),
    importance: z.literal("critical_candidate"),
    reasons: z
      .array(
        z.enum([
          "schedule",
          "deadline_action",
          "payment",
          "security",
          "personal_action",
          "custom",
        ]),
      )
      .min(1),
    change: z.enum(["new_identity", "changed_metadata"]),
    identityQuality: z.literal("metadata_derived"),
    trust: z.literal("untrusted_source"),
  })
  .strict();
export const noticeEventSchema = z
  .object({
    eventId: fingerprintSchema,
    name: z.literal("unipa.important_notice_detected"),
    timestamp: z.iso.datetime(),
    data: payloadSchema,
    cursor: z.null(),
  })
  .strict();
export type NoticeEvent = z.infer<typeof noticeEventSchema>;
const recordSchema = z
  .object({
    versions: z.array(fingerprintSchema).min(1).max(20),
    lastSeenAt: z.number().finite().nonnegative(),
  })
  .strict();
const itemSchema = z
  .object({
    event: noticeEventSchema,
    attempts: z.number().int().min(0).max(10),
    nextAttemptAt: z.number().finite().nonnegative(),
    status: z.enum(["pending", "accepted", "discarded"]),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scopeKey: fingerprintSchema,
    lastSnapshotAt: z.number().finite().nonnegative(),
    records: z
      .record(noticeIdSchema, recordSchema)
      .refine((r) => Object.keys(r).length <= 10_000),
    outbox: z.array(itemSchema).max(1000),
    deliveryPaused: z
      .enum(["destination_gone", "authorization_failed"])
      .nullable(),
  })
  .strict();
export type NoticeEventState = z.infer<typeof stateSchema>;
export class NoticeEventError extends Error {
  constructor(
    public readonly code:
      | "INVALID_SNAPSHOT"
      | "INVALID_STATE"
      | "SCOPE_MISMATCH"
      | "CAPACITY_EXCEEDED",
  ) {
    super(code);
  }
}
const retentionMs = 30 * 24 * 3600_000;
const freshMs = 2 * 60_000;

function readState(raw: unknown, scopeKey: string): NoticeEventState {
  const result = stateSchema.safeParse(raw);
  if (!result.success) throw new NoticeEventError("INVALID_STATE");
  if (result.data.scopeKey !== scopeKey)
    throw new NoticeEventError("SCOPE_MISMATCH");
  return result.data;
}

// A serialized, authenticated owner must atomically persist this transition before dispatch.
// No KV writes, timers, detail reads, or outbound deliveries occur here.
export async function reconcileNoticeEvents(
  snapshot: Snapshot,
  prior: unknown | undefined,
  scopeKey: string,
  importance: ImportancePolicy = {},
  now = Date.now(),
): Promise<{
  state: NoticeEventState;
  baseline: boolean;
  reviewNoticeIds: string[];
  warnings: string[];
}> {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (
    !parsed.success ||
    !Number.isFinite(now) ||
    now < 0 ||
    !fingerprintSchema.safeParse(scopeKey).success
  )
    throw new NoticeEventError("INVALID_SNAPSHOT");
  const capturedAt = Date.parse(parsed.data.fetchedAt);
  if (capturedAt > now || now - capturedAt >= freshMs)
    throw new NoticeEventError("INVALID_SNAPSHOT");
  const baseline = prior === undefined;
  const state: NoticeEventState = baseline
    ? {
        schemaVersion: 1,
        scopeKey,
        lastSnapshotAt: capturedAt,
        records: {},
        outbox: [],
        deliveryPaused: null,
      }
    : readState(prior, scopeKey);
  if (!baseline && capturedAt < state.lastSnapshotAt)
    throw new NoticeEventError("INVALID_SNAPSHOT");
  // Version fingerprints dedupe cached/replayed snapshots while retaining unknowns.
  const replayed = !baseline && capturedAt === state.lastSnapshotAt;
  state.outbox = state.outbox.filter(
    (item) =>
      item.status === "pending" ||
      now - Date.parse(item.event.timestamp) < retentionMs,
  );
  const pendingIds = new Set(
    state.outbox
      .filter((item) => item.status === "pending")
      .map((item) => item.event.data.noticeId),
  );
  for (const [id, record] of Object.entries(state.records))
    if (now - record.lastSeenAt >= retentionMs && !pendingIds.has(id))
      delete state.records[id];
  const reviewNoticeIds: string[] = [];
  for (const notice of parsed.data.notices) {
    const decision = classifyImportance(notice, importance);
    if (decision.level === "unknown" && notice.unread !== false)
      reviewNoticeIds.push(notice.id);
    // Read state is intentionally excluded: body acquisition must not create an event loop.
    const version = await digest(
      JSON.stringify([
        notice.title,
        notice.category,
        notice.sender,
        notice.postedDate,
        notice.important,
      ]),
    );
    const old = Object.hasOwn(state.records, notice.id)
      ? state.records[notice.id]
      : undefined;
    const changed = !old?.versions.includes(version);
    if (old && changed && old.versions.length >= 20)
      throw new NoticeEventError("CAPACITY_EXCEEDED");
    state.records[notice.id] = {
      versions: changed ? [...(old?.versions ?? []), version] : old!.versions,
      lastSeenAt: capturedAt,
    };
    if (
      baseline ||
      !changed ||
      notice.unread !== true ||
      decision.level !== "critical_candidate"
    )
      continue;
    const event: NoticeEvent = {
      eventId: await digest(JSON.stringify([scopeKey, notice.id, version])),
      name: "unipa.important_notice_detected",
      timestamp: parsed.data.fetchedAt,
      data: {
        noticeId: notice.id,
        title: notice.title,
        category: notice.category,
        sender: notice.sender,
        postedDate: notice.postedDate,
        officialUrl: notice.officialUrl,
        unreadAtDetection: true,
        importance: "critical_candidate",
        reasons: decision.reasons,
        change: old ? "changed_metadata" : "new_identity",
        identityQuality: "metadata_derived",
        trust: "untrusted_source",
      },
      cursor: null,
    };
    if (!state.outbox.some((item) => item.event.eventId === event.eventId))
      state.outbox.push({
        event,
        attempts: 0,
        nextAttemptAt: now,
        status: "pending",
      });
  }
  if (Object.keys(state.records).length > 10_000 || state.outbox.length > 1000)
    throw new NoticeEventError("CAPACITY_EXCEEDED");
  state.lastSnapshotAt = capturedAt;
  return {
    state,
    baseline,
    reviewNoticeIds,
    warnings: [
      "METADATA_DERIVED_ID_MAY_CHANGE_ON_EDIT",
      ...(baseline ? ["INITIAL_BASELINE_NO_DELIVERY"] : []),
      ...(replayed ? ["REPLAYED_SNAPSHOT"] : []),
    ],
  };
}

export interface NoticeEventTransport {
  // Implementations own subscription authorization, HTTPS/DNS validation and signing.
  deliver(event: NoticeEvent): Promise<{ status: number }>;
}
export const dispatchPolicySchema = z.object({
  enabled: z.boolean().default(false),
  maxPerCycle: z.number().int().min(1).max(20).default(3),
  maxAttempts: z.number().int().min(1).max(10).default(5),
});

// Default-disabled transport boundary. A crash before saving can repeat the same event ID.
export async function dispatchNoticeOutbox(
  prior: unknown,
  scopeKey: string,
  transport: NoticeEventTransport,
  input: z.input<typeof dispatchPolicySchema> = {},
  now = Date.now(),
): Promise<NoticeEventState> {
  const state = readState(prior, scopeKey);
  const policy = dispatchPolicySchema.parse(input);
  if (!Number.isFinite(now) || now < 0)
    throw new NoticeEventError("INVALID_STATE");
  if (!policy.enabled || state.deliveryPaused) return state;
  let attempted = 0;
  for (const item of state.outbox) {
    if (item.status !== "pending" || item.nextAttemptAt > now) continue;
    if (item.attempts >= policy.maxAttempts) {
      item.status = "discarded";
      continue;
    }
    if (attempted++ >= policy.maxPerCycle) break;
    item.attempts++;
    let status = 0;
    try {
      status = (await transport.deliver(item.event)).status;
    } catch {
      /* Never preserve upstream exception details. */
    }
    if (status >= 200 && status < 300) item.status = "accepted";
    else if (status === 410 || status === 401 || status === 403) {
      state.deliveryPaused =
        status === 410 ? "destination_gone" : "authorization_failed";
      break;
    } else if (
      status === 413 ||
      (status >= 400 && status < 500 && status !== 429) ||
      item.attempts >= policy.maxAttempts
    )
      item.status = "discarded";
    else
      item.nextAttemptAt =
        now + Math.min(3600_000, 30_000 * 2 ** (item.attempts - 1));
  }
  return state;
}
