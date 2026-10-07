import { z } from "zod";
import {
  acquireImportantBodies,
  bodyPolicySchema,
  type BodyResult,
} from "./body";
import { createNoticeBoardBodyReader } from "./detail-reader";
import {
  importantNoticeEventDefinition,
  validWebhookSecret,
} from "./event-protocol";
import {
  dispatchNoticeOutbox,
  reconcileNoticeEvents,
  type NoticeEventState,
  type NoticeEvent,
} from "./events";
import { importancePolicySchema, classifyImportance } from "./importance";
import { digest, type collectNoticeBoard } from "./notices";
import {
  noticePollDue,
  snapshotFreshUntil,
  nextNoticeSlot,
  unipaMaintenance,
} from "./polling";
import {
  permanentFailure,
  safeError,
  type Notice,
  type Snapshot,
} from "./types";
import {
  SubscriptionWebhookTransport,
  validateCallbackUrl,
  type WebhookDestination,
} from "./webhook";

export const NOTICE_BODY_RETENTION_MS = 24 * 3600_000;
export const NOTICE_METADATA_RETENTION_MS = 30 * 24 * 3600_000;

export const monitorPrincipalSchema = z
  .object({
    userId: z.string().min(1).max(256),
    email: z.email(),
    grantId: z.string().min(1).max(256),
  })
  .strict();
export type MonitorPrincipal = z.infer<typeof monitorPrincipalSchema>;
export const unsubscribeSchema = z
  .object({
    name: z.literal("unipa.important_notice_detected"),
    arguments: z.object({}).strict(),
    delivery: z
      .object({ mode: z.literal("webhook"), url: z.string().max(2048) })
      .strict(),
  })
  .strict();
export const subscribeSchema = z
  .object({
    name: z.literal("unipa.important_notice_detected"),
    arguments: z.object({}).strict(),
    delivery: z
      .object({
        mode: z.literal("webhook"),
        url: z.string().max(2048),
        secret: z.string().max(128).refine(validWebhookSecret),
      })
      .strict(),
    cursor: z.null().optional(),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 3600_000)
      .nullable()
      .optional(),
  })
  .strict();
interface Subscription extends WebhookDestination {
  verifiedUntil?: number;
  owner: MonitorPrincipal;
  expiresAt: number;
  outbox: NoticeEventState["outbox"];
  paused: NoticeEventState["deliveryPaused"];
}
interface ArchivedNotice {
  origin?: "event" | "manual";
  eventId: string;
  notice: Notice;
  detectedAt: string;
  expiresAt: number;
  acquisition:
    | "pending"
    | "attempting"
    | "complete"
    | "uncertain_after_interrupted_read"
    | "expired";
  result?: BodyResult;
}
interface MonitorData {
  schemaVersion: 1;
  owner?: MonitorPrincipal;
  subscriptions: Subscription[];
  archive: ArchivedNotice[];
  snapshot?: Snapshot;
  state?: NoticeEventState;
  lastAttemptAt: number | null;
  retryAt?: number | null;
  reason?: string;
  revision: string;
}
export interface MonitorStore {
  load(): Promise<MonitorData | undefined>;
  save(data: MonitorData): Promise<void>;
}
export interface MonitorDependencies {
  store: MonitorStore;
  canAccess(owner: MonitorPrincipal): Promise<boolean>;
  scope(owner: MonitorPrincipal): Promise<string>;
  collect(owner: MonitorPrincipal): ReturnType<typeof collectNoticeBoard>;
  webhook: SubscriptionWebhookTransport;
  allowedHosts: string[];
  revision(): string;
  enabled: boolean;
  bodyEnabled: boolean;
  backfillEnabled?: boolean;
  allowReadStateChange: boolean;
  importance?: z.input<typeof importancePolicySchema>;
}
export class MonitorError extends Error {
  constructor(
    public readonly code: number,
    public readonly reason: string,
  ) {
    super(reason);
  }
}

// A persistent backing store plus this queue serializes subscribe/poll/read/unsubscribe.
// The Worker wrapper uses one Durable Object; no KV lease is used as a distributed lock.
export class UnipaNoticeMonitor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dependencies: MonitorDependencies) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async authorize(owner: MonitorPrincipal) {
    if (
      !this.dependencies.enabled ||
      !monitorPrincipalSchema.safeParse(owner).success ||
      !(await this.dependencies.canAccess(owner))
    )
      throw new MonitorError(-32001, "MONITOR_ACCESS_REQUIRED");
  }
  private async data(owner?: MonitorPrincipal): Promise<MonitorData> {
    const data = structuredClone(await this.dependencies.store.load()) ?? {
      schemaVersion: 1 as const,
      subscriptions: [],
      archive: [],
      lastAttemptAt: null,
      revision: this.dependencies.revision(),
    };
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.subscriptions) ||
      data.subscriptions.length > 4 ||
      !Array.isArray(data.archive) ||
      data.archive.length > 1000
    )
      throw new MonitorError(-32603, "MONITOR_STATE_INVALID");
    if (
      owner &&
      data.owner &&
      (data.owner.userId !== owner.userId ||
        data.owner.email.toLowerCase() !== owner.email.toLowerCase())
    )
      throw new MonitorError(-32001, "MONITOR_ACCESS_REQUIRED");
    if (data.revision !== this.dependencies.revision()) {
      data.retryAt = undefined;
      data.reason = undefined;
      data.revision = this.dependencies.revision();
    }
    const now = Date.now();
    data.archive = data.archive.filter(
      (item) =>
        now - Date.parse(item.detectedAt) < NOTICE_METADATA_RETENTION_MS,
    );
    for (const item of data.archive)
      if (item.expiresAt <= now) {
        const readStateMayHaveChanged =
          item.result?.readStateMayHaveChanged ??
          (item.acquisition === "attempting" ||
            item.acquisition === "uncertain_after_interrupted_read");
        item.acquisition = "expired";
        item.result = {
          noticeId: item.notice.id,
          unreadAtDetection: item.notice.unread,
          status: "expired",
          readStateMayHaveChanged,
        };
      } // Keep only metadata/tombstones; never extend private body retention for failed delivery.
    data.subscriptions = data.subscriptions.filter(
      (item) => item.expiresAt > now,
    );
    for (const subscription of data.subscriptions) {
      if ((subscription.rotationUntil ?? 0) <= now) {
        delete subscription.previousSecret;
        delete subscription.rotationUntil;
      }
      subscription.outbox = subscription.outbox.filter(
        (item) => now - Date.parse(item.event.timestamp) < 30 * 24 * 3600_000,
      );
    }
    if (
      data.snapshot &&
      now - Date.parse(data.snapshot.fetchedAt) >= 24 * 3600_000
    )
      delete data.snapshot;
    if (data.state) {
      data.state.records = Object.fromEntries(
        Object.entries(data.state.records).filter(
          ([, item]) => now - item.lastSeenAt < 30 * 24 * 3600_000,
        ),
      );
      data.state.outbox = data.state.outbox.filter(
        (item) => now - Date.parse(item.event.timestamp) < 30 * 24 * 3600_000,
      );
      if (
        !Object.keys(data.state.records).length &&
        !data.state.outbox.length &&
        now - data.state.lastSnapshotAt >= 30 * 24 * 3600_000
      )
        delete data.state;
    }
    if (
      !data.state &&
      !data.snapshot &&
      !data.archive.length &&
      !data.subscriptions.length
    )
      delete data.owner;
    return data;
  }
  purgeExpired() {
    return this.serial(async () => {
      await this.dependencies.store.save(await this.data());
    });
  }
  retryDeliveries() {
    return this.poll(undefined, undefined, false);
  }
  private bodyReference(
    data: MonitorData,
    event: Pick<NoticeEvent, "eventId" | "timestamp">,
  ) {
    const cached = data.archive.find((item) => item.eventId === event.eventId);
    const expiresAt =
      cached?.expiresAt ??
      Date.parse(event.timestamp) + NOTICE_BODY_RETENTION_MS;
    return {
      status:
        Date.now() >= expiresAt
          ? ("expired" as const)
          : cached?.result?.status === "retrieved" && cached.result.body
            ? ("available" as const)
            : ("unavailable" as const),
      expiresAt: new Date(expiresAt).toISOString(),
      tool: "unipa_read_cached_important_notice" as const,
      readStateMayHaveChanged: cached?.result?.readStateMayHaveChanged ?? null,
    };
  }
  listEvents(owner: MonitorPrincipal) {
    return this.serial(async () => {
      await this.authorize(owner);
      return { events: [importantNoticeEventDefinition] };
    });
  }
  subscribe(owner: MonitorPrincipal, raw: unknown) {
    return this.serial(async () => {
      await this.authorize(owner);
      const parsed = subscribeSchema.safeParse(raw);
      if (!parsed.success)
        throw new MonitorError(-32602, "INVALID_SUBSCRIPTION");
      const request = parsed.data;
      let url: string;
      try {
        url = validateCallbackUrl(
          request.delivery.url,
          this.dependencies.allowedHosts,
        );
      } catch {
        throw new MonitorError(-32015, "callback_invalid");
      }
      const id = await digest(
        JSON.stringify([owner.userId, url, request.name, {}]),
      );
      const now = Date.now();
      let data = await this.data(owner);
      data.subscriptions = data.subscriptions.filter((s) => s.expiresAt > now);
      const old = data.subscriptions.find((s) => s.id === id);
      if (!old && data.subscriptions.length >= 4)
        throw new MonitorError(-32001, "SUBSCRIPTION_LIMIT");
      const subscription: Subscription = {
        id,
        owner,
        url,
        secret: request.delivery.secret,
        expiresAt:
          now +
          Math.max(
            15 * 60_000,
            Math.min(24 * 3600_000, request.ttlMs ?? 24 * 3600_000),
          ),
        outbox: old?.outbox ?? [],
        paused: null,
        verifiedUntil: now + 5 * 60_000,
        ...(old && old.secret !== request.delivery.secret
          ? { previousSecret: old.secret, rotationUntil: now + 5 * 60_000 }
          : old?.rotationUntil && old.rotationUntil > now
            ? {
                previousSecret: old.previousSecret,
                rotationUntil: old.rotationUntil,
              }
            : {}),
      };
      try {
        if (!(
          old &&
          old.owner.grantId === owner.grantId &&
          old.secret === subscription.secret &&
          !old.paused &&
          (old.verifiedUntil ?? 0) > now
        ))
          await this.dependencies.webhook.verify(subscription);
        else subscription.verifiedUntil = old.verifiedUntil;
      } catch {
        throw new MonitorError(-32015, "challenge_failed");
      }
      // Verify ownership again after a slow callback challenge.
      await this.authorize(owner);
      data.owner = owner;
      data.subscriptions = [
        ...data.subscriptions.filter((s) => s.id !== id),
        subscription,
      ];
      await this.dependencies.store.save(data);
      return {
        id,
        refreshBefore: new Date(subscription.expiresAt).toISOString(),
        cursor: null,
        truncated: false,
      };
    });
  }
  unsubscribe(owner: MonitorPrincipal, id: string) {
    return this.serial(async () => {
      await this.authorize(owner);
      const data = await this.data(owner);
      data.subscriptions = data.subscriptions.filter((s) => s.id !== id);
      await this.dependencies.store.save(data);
      return {};
    });
  }
  unsubscribeRequest(owner: MonitorPrincipal, raw: unknown) {
    const parsed = unsubscribeSchema.safeParse(raw);
    if (!parsed.success)
      return Promise.reject(new MonitorError(-32602, "INVALID_SUBSCRIPTION"));
    let url: string;
    try {
      url = validateCallbackUrl(
        parsed.data.delivery.url,
        this.dependencies.allowedHosts,
      );
    } catch {
      return Promise.reject(new MonitorError(-32602, "INVALID_SUBSCRIPTION"));
    }
    return digest(
      JSON.stringify([owner.userId, url, parsed.data.name, {}]),
    ).then((id) => this.unsubscribe(owner, id));
  }
  prepareBackfill(owner: MonitorPrincipal, raw: unknown) {
    return this.serial(async () => {
      await this.authorize(owner);
      const input = z
        .object({
          noticeIds: z
            .array(z.string().regex(/^[a-f0-9]{64}:[1-9]\d{0,3}$/))
            .min(1)
            .max(3)
            .refine((ids) => new Set(ids).size === ids.length),
          mode: z.enum(["preview", "queue"]).default("preview"),
        })
        .strict()
        .safeParse(raw);
      if (!input.success)
        throw new MonitorError(-32602, "INVALID_BACKFILL_SELECTION");
      const data = await this.data(owner);
      if (!data.snapshot)
        throw new MonitorError(-32001, "SNAPSHOT_UNAVAILABLE");
      const selected = input.data.noticeIds.map((id) =>
        data.snapshot!.notices.find((n) => n.id === id),
      );
      if (
        selected.some(
          (n) =>
            !n ||
            n.unread !== true ||
            classifyImportance(n, this.dependencies.importance).level !==
              "critical_candidate",
        )
      )
        throw new MonitorError(-32602, "BACKFILL_REQUIRES_IMPORTANT_UNREAD");
      if (
        input.data.mode === "queue" &&
        (!this.dependencies.backfillEnabled ||
          !this.dependencies.bodyEnabled ||
          !this.dependencies.allowReadStateChange ||
          !data.subscriptions.some(
            (s) =>
              s.expiresAt > Date.now() && s.owner.grantId === owner.grantId,
          ))
      )
        throw new MonitorError(-32001, "BACKFILL_NOT_ENABLED_OR_SUBSCRIBED");
      const scope = await this.dependencies.scope(owner);
      const prepared = await Promise.all(
        selected.map(async (notice) => ({
          notice: notice!,
          eventId: await digest(
            JSON.stringify(["manual-backfill", scope, notice]),
          ),
        })),
      );
      if (input.data.mode === "queue") {
        data.archive = data.archive.filter(
          (cached) =>
            cached.acquisition !== "expired" ||
            !prepared.some((item) => item.eventId === cached.eventId),
        );
        const additions = prepared.filter(
          (item) =>
            !data.archive.some((cached) => cached.eventId === item.eventId),
        );
        if (
          data.archive.filter(
            (item) =>
              item.origin === "manual" && item.acquisition === "pending",
          ).length +
            additions.length >
            3 ||
          data.archive.length + additions.length > 1000
        )
          throw new MonitorError(-32001, "BACKFILL_CAPACITY_EXCEEDED");
        data.owner = owner;
        data.archive.push(
          ...additions.map((item): ArchivedNotice => ({
            ...item,
            origin: "manual",
            detectedAt: new Date(Date.now()).toISOString(),
            expiresAt: Date.now() + 24 * 3600_000,
            acquisition: "pending",
          })),
        );
        await this.dependencies.store.save(data);
      }
      return {
        mode: input.data.mode,
        items: prepared,
        nextFetchAt: new Date(nextNoticeSlot()).toISOString(),
        limit: 3,
        note: "選択した重要未読のみ、次の取得枠で一件ずつ本文取得します。既読化する場合があります。予約だけではUNIPAへ接続せず、過去通知のWebhookは送信しません。",
      };
    });
  }
  poll(owner?: MonitorPrincipal, scheduledAt?: number, allowCollection = true) {
    return this.serial(async () => {
      if (!this.dependencies.enabled) return { status: "disabled" };
      if (owner) await this.authorize(owner);
      let data = await this.data(owner);
      const now = Date.now();
      const active: Subscription[] = [];
      for (const subscription of data.subscriptions)
        if (
          subscription.expiresAt > now &&
          (await this.dependencies.canAccess(subscription.owner))
        ) {
          subscription.outbox = subscription.outbox.filter(
            (item) =>
              item.status === "pending" ||
              now - Date.parse(item.event.timestamp) < 30 * 24 * 3600_000,
          );
          if ((subscription.rotationUntil ?? 0) <= now) {
            delete subscription.previousSecret;
            delete subscription.rotationUntil;
          }
          active.push(subscription);
        }
      data.subscriptions = active;
      const principal = owner ?? active[0]?.owner;
      if (!principal) {
        await this.dependencies.store.save(data);
        return { status: "no_subscription" };
      }
      await this.authorize(principal);
      data.owner = principal;
      for (const item of data.archive)
        if (item.acquisition === "attempting")
          item.acquisition = "uncertain_after_interrupted_read";
      const scope = await this.dependencies.scope(principal);
      if (
        allowCollection &&
        noticePollDue(
          { enabled: true },
          data.lastAttemptAt,
          data.retryAt,
          now,
          scheduledAt,
        )
      ) {
        data.lastAttemptAt = now;
        await this.dependencies.store.save(data); // Rate limit survives crashes before HTTP.
        try {
          const board = await this.dependencies.collect(principal);
          const transition = await reconcileNoticeEvents(
            board.snapshot,
            data.state,
            scope,
            this.dependencies.importance,
            Date.now(),
          );
          data.snapshot = board.snapshot;
          data.state = transition.state;
          data.retryAt = undefined;
          data.reason = undefined;
          const newlyDetected = data.state.outbox.filter(
            (item) => item.status === "pending",
          );
          for (const item of newlyDetected) {
            for (const subscription of active)
              if (
                !subscription.outbox.some(
                  (queued) => queued.event.eventId === item.event.eventId,
                )
              )
                subscription.outbox.push(structuredClone(item));
            const notice = board.snapshot.notices.find(
              (n) => n.id === item.event.data.noticeId,
            )!;
            if (
              !data.archive.some(
                (archived) => archived.eventId === item.event.eventId,
              )
            )
              data.archive.push({
                eventId: item.event.eventId,
                notice,
                detectedAt: item.event.timestamp,
                expiresAt: Date.now() + NOTICE_BODY_RETENTION_MS,
                acquisition: "pending",
              });
            item.status = "accepted"; // Fan-out queued durably; this is NOT webhook acceptance.
          }
          if (
            data.archive.length > 1000 ||
            active.some((s) => s.outbox.length > 1000)
          )
            throw new MonitorError(-32603, "MONITOR_CAPACITY_EXCEEDED");
          await this.dependencies.store.save(data); // Save detection/outbox before a read can mark it read.
          const archived = data.archive.find(
            (item) => item.acquisition === "pending",
          );
          if (archived) {
            const current = board.snapshot.notices.find(
              (n) => n.id === archived.notice.id,
            );
            archived.acquisition = "attempting";
            await this.dependencies.store.save(data); // No automatic retry after an ambiguous crash.
            const results = await acquireImportantBodies(
              current ? [current] : [archived.notice],
              bodyPolicySchema.parse({
                enabled: this.dependencies.bodyEnabled,
                allowReadStateChange: this.dependencies.allowReadStateChange,
                maxPerCycle: 1,
              }),
              this.dependencies.importance,
              current ? createNoticeBoardBodyReader(board) : undefined,
            );
            archived.result = results[0];
            archived.acquisition = "complete";
            if (archived.result?.failure) {
              const failure = archived.result.failure;
              data.reason = failure.code;
              data.retryAt = permanentFailure(failure.code)
                ? null
                : Math.max(
                    nextNoticeSlot(Date.now()),
                    Date.now() + failure.retryAfterSeconds * 1000,
                  );
            }
            await this.dependencies.store.save(data);
          }
        } catch (error) {
          data = await this.data(principal); // Keep the last durably committed transition.
          const failure = safeError(error);
          data.reason =
            error instanceof MonitorError ? error.reason : failure.code;
          data.retryAt = permanentFailure(failure.code)
            ? null
            : Math.max(
                nextNoticeSlot(Date.now()),
                Date.now() + failure.retryAfterSeconds * 1000,
              );
          await this.dependencies.store.save(data);
        }
      }
      // Outbox dispatch is independent of the notice's current read flag and body success.
      if (data.state)
        for (const subscription of data.subscriptions) {
          if (!(await this.dependencies.canAccess(subscription.owner)))
            continue;
          const result = await dispatchNoticeOutbox(
            {
              ...data.state,
              outbox: subscription.outbox.filter((item) => {
                const cached = data.archive.find(
                  (entry) => entry.eventId === item.event.eventId,
                );
                return (
                  !cached ||
                  cached.acquisition === "complete" ||
                  cached.acquisition === "expired" ||
                  cached.acquisition === "uncertain_after_interrupted_read"
                );
              }),
              deliveryPaused: subscription.paused,
            },
            scope,
            {
              deliver: async (event) => {
                if (
                  !(await this.dependencies.canAccess(subscription.owner)) ||
                  subscription.expiresAt <= Date.now()
                )
                  return { status: 403 };
                // Persist the attempt budget/backoff before sending, including crash paths.
                const pending = subscription.outbox.find(
                  (item) => item.event.eventId === event.eventId,
                )!;
                pending.attempts++;
                pending.nextAttemptAt =
                  Date.now() +
                  Math.min(3600_000, 30_000 * 2 ** (pending.attempts - 1));
                await this.dependencies.store.save(data);
                return this.dependencies.webhook.deliver(subscription, {
                  ...event,
                  data: {
                    ...event.data,
                    bodyReference: this.bodyReference(data, event),
                  },
                });
              },
            },
            { enabled: true },
          );
          const dispatched = new Map(
            result.outbox.map((item) => [item.event.eventId, item]),
          );
          subscription.outbox = subscription.outbox.map(
            (item) => dispatched.get(item.event.eventId) ?? item,
          );
          subscription.paused = result.deliveryPaused;
          await this.dependencies.store.save(data);
        }
      return {
        status: data.reason ? "stale" : "ok",
        reason: data.reason ?? null,
        lastAttemptAt: data.lastAttemptAt,
        baseline: data.state?.outbox.length === 0,
      };
    });
  }
  readBody(owner: MonitorPrincipal, eventId: string) {
    return this.serial(async () => {
      await this.authorize(owner);
      const data = await this.data(owner);
      const archived = data.archive.find((item) => item.eventId === eventId);
      return archived
        ? {
            eventId,
            notice: archived.notice,
            unreadAtDetection: archived.notice.unread,
            acquisition: archived.acquisition,
            bodyReference: this.bodyReference(data, {
              eventId,
              timestamp: archived.detectedAt,
            }),
            result: archived.result ?? null,
            trust: "untrusted_source",
            note: "本文取得による既読化と、GPT側の判定・通知完了は別の状態です。",
          }
        : (() => {
            const event = data.state?.outbox.find(
              (item) => item.event.eventId === eventId,
            )?.event;
            return event
              ? {
                  eventId,
                  status: "not_available",
                  reason: "NOT_CACHED_OR_EXPIRED",
                  notice: event.data,
                  bodyReference: this.bodyReference(data, event),
                  trust: "untrusted_source",
                }
              : {
                  eventId,
                  status: "not_available",
                  reason: "NOT_CACHED_OR_EXPIRED",
                };
          })();
    });
  }
  readSnapshot(owner: MonitorPrincipal) {
    return this.serial(async () => {
      await this.authorize(owner);
      const data = await this.data(owner);
      if (
        !data.snapshot ||
        Date.now() - Date.parse(data.snapshot.fetchedAt) >= 24 * 3600_000
      )
        throw new MonitorError(-32001, "SNAPSHOT_UNAVAILABLE");
      return {
        ...data.snapshot,
        cacheExpiresAt: new Date(
          snapshotFreshUntil(data.snapshot.fetchedAt),
        ).toISOString(),
        stale: Date.now() >= snapshotFreshUntil(data.snapshot.fetchedAt),
        warnings: data.reason ? [data.reason] : [],
        officialUrl:
          data.snapshot.notices[0]?.officialUrl ??
          "https://unipa.i-u.ac.jp/uprx/",
      };
    });
  }
  status(owner: MonitorPrincipal) {
    return this.serial(async () => {
      await this.authorize(owner);
      const data = await this.data(owner);
      const valid =
        data.snapshot &&
        Date.now() - Date.parse(data.snapshot.fetchedAt) < 24 * 3600_000;
      return {
        enabled: true,
        configured: true,
        authenticated: null,
        lastSuccessAt: valid ? data.snapshot!.fetchedAt : null,
        stale:
          !valid || Date.now() >= snapshotFreshUntil(data.snapshot!.fetchedAt),
        complete: Boolean(valid),
        totalCount: valid ? data.snapshot!.totalCount : null,
        reason: data.reason ?? null,
        automaticRetryPaused: data.retryAt === null,
        retryAt:
          typeof data.retryAt === "number"
            ? new Date(data.retryAt).toISOString()
            : null,
        activeSubscriptions: data.subscriptions.filter(
          (s) => s.expiresAt > Date.now(),
        ).length,
        deliveryPaused: data.subscriptions.some((s) => s.paused !== null),
        pendingDeliveries: data.subscriptions.reduce(
          (total, s) =>
            total + s.outbox.filter((item) => item.status === "pending").length,
          0,
        ),
        timezone: "Asia/Tokyo",
        fetchTimes: ["07:00", "12:00", "17:00"],
        nextFetchAt: new Date(nextNoticeSlot()).toISOString(),
        maintenance: unipaMaintenance(),
        note: "状態確認はUNIPAへログインしません。Webhook受理とAI判定・利用者への通知完了は別です。",
      };
    });
  }
}
