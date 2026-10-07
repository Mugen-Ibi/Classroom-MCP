import { z } from "zod";
import { unipaConfig } from "./config";
import { digest } from "./notices";
import {
  UNIPA_PORTAL,
  UnipaError,
  safeError,
  type ErrorCode,
  type Snapshot,
  type UnipaBindings,
  type UnipaOwner,
} from "./types";
import type { Transport } from "./session";
import { snapshotFreshUntil, unipaMaintenance } from "./polling";

const ttl = 24 * 3600;
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    fetchedAt: z.iso.datetime(),
    totalCount: z.number().int().min(0).max(1000),
    complete: z.literal(true),
    notices: z
      .array(
        z.object({
          id: z.string().max(100),
          source: z.literal("unipa"),
          title: z.string().min(1).max(2000),
          category: z.string().max(256),
          sender: z.string().max(256),
          postedDate: z.iso.date(),
          unread: z.boolean().nullable(),
          important: z.boolean(),
          officialUrl: z.literal(UNIPA_PORTAL),
        }),
      )
      .max(1000),
  })
  .refine((s) => s.totalCount === s.notices.length);
const stateSchema = z.object({
  code: z.enum([
    "AUTH_REJECTED",
    "INTERACTIVE_AUTH_REQUIRED",
    "SESSION_EXPIRED",
    "FORMAT_CHANGED",
    "INCOMPLETE_LIST",
    "NETWORK_ERROR",
    "RATE_LIMITED",
    "UPDATE_PENDING",
  ]),
  retryAt: z.number().finite().nullable(),
});
export type SnapshotResult = Snapshot & {
  cacheExpiresAt: string;
  stale: boolean;
  warnings: string[];
  officialUrl: string;
};

export class UnipaService {
  constructor(
    private readonly env: UnipaBindings,
    private readonly owner: UnipaOwner,
    private readonly signal?: AbortSignal,
    private readonly transport?: Transport,
    private readonly monitor?: {
      list(): Promise<SnapshotResult>;
      status(): Promise<Record<string, unknown>>;
    },
  ) {}

  private async storage() {
    const config = unipaConfig(this.env, this.owner);
    // Passwords are never hashed into stored metadata. Revision is an explicit retry reset.
    const key = `unipa:v1:${await digest(JSON.stringify([config.ownerId, config.userId, config.revision]))}`;
    return { ...config, key };
  }
  private async read(kv: KVNamespace, key: string) {
    try {
      const [raw, state, lease] = await Promise.all([
        kv.get(key, "json"),
        kv.get(`${key}:state`, "json"),
        kv.get(`${key}:lease`, "json"),
      ]);
      const snapshot = snapshotSchema.safeParse(raw);
      const failure = stateSchema.safeParse(state);
      const pending = stateSchema.safeParse(lease);
      // Application expiry also applies when a KV implementation returns expired data.
      const activeFailure =
        failure.success &&
        (failure.data.retryAt === null || failure.data.retryAt > Date.now());
      return {
        snapshot:
          snapshot.success &&
          Date.now() - Date.parse(snapshot.data.fetchedAt) < ttl * 1000 &&
          Date.parse(snapshot.data.fetchedAt) <= Date.now()
            ? (snapshot.data as Snapshot)
            : undefined,
        state: activeFailure
          ? failure.data
          : pending.success &&
              pending.data.retryAt !== null &&
              pending.data.retryAt > Date.now()
            ? pending.data
            : failure.success
              ? failure.data
              : undefined,
      };
    } catch {
      throw new UnipaError("CACHE_UNAVAILABLE");
    }
  }
  async status() {
    try {
      const { kv, key } = await this.storage();
      if (this.monitor) return await this.monitor.status();
      const { snapshot, state } = await this.read(kv, key);
      return {
        enabled: true,
        configured: true,
        authenticated: null,
        lastSuccessAt: snapshot?.fetchedAt ?? null,
        stale:
          !snapshot || Date.now() >= snapshotFreshUntil(snapshot.fetchedAt),
        complete: snapshot?.complete ?? false,
        totalCount: snapshot?.totalCount ?? null,
        reason: state?.code ?? null,
        retryAt: state?.retryAt ? new Date(state.retryAt).toISOString() : null,
        automaticRetryPaused: state?.retryAt === null,
        officialUrl: UNIPA_PORTAL,
        note: "接続状態の確認だけではUNIPAへログインしません。認証停止後は本人が通常ログインとSecretsを確認し、UNIPA_AUTH_REVISIONを変更してください。",
      };
    } catch (error) {
      const safe = safeError(error);
      return {
        enabled: true,
        configured: false,
        reason: safe.code,
        message: safe.message,
        officialUrl: UNIPA_PORTAL,
      };
    }
  }

  async list(): Promise<SnapshotResult> {
    const config = await this.storage();
    if (this.monitor) return this.monitor.list();
    const { snapshot, state } = await this.read(config.kv, config.key);
    // Tools only read caches. The authorized Durable Object's scheduled collector
    // is the sole production refresh path; old grants cannot trigger extra logins.
    if (snapshot)
      return this.result(
        snapshot,
        Date.now() >= snapshotFreshUntil(snapshot.fetchedAt),
        state ? [state.code] : [],
      );
    throw new UnipaError(
      unipaMaintenance() ? "MAINTENANCE_WINDOW" : "OUTSIDE_FETCH_WINDOW",
    );
  }
  private result(
    snapshot: Snapshot,
    stale: boolean,
    warnings: ErrorCode[],
  ): SnapshotResult {
    return {
      ...snapshot,
      cacheExpiresAt: new Date(
        snapshotFreshUntil(snapshot.fetchedAt),
      ).toISOString(),
      stale,
      warnings,
      officialUrl: UNIPA_PORTAL,
    };
  }
}
