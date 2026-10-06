import { z } from "zod";
import { unipaConfig } from "./config";
import { collectNotices, digest } from "./notices";
import {
  UNIPA_PORTAL,
  UnipaError,
  permanentFailure,
  safeError,
  type ErrorCode,
  type Snapshot,
  type UnipaBindings,
  type UnipaOwner,
} from "./types";
import type { Transport } from "./session";

const freshMs = 15 * 60_000;
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
type State = z.infer<typeof stateSchema>;
const inFlight = new WeakMap<object, Map<string, Promise<Snapshot>>>();

export class UnipaService {
  constructor(
    private readonly env: UnipaBindings,
    private readonly owner: UnipaOwner,
    private readonly signal?: AbortSignal,
    private readonly transport?: Transport,
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
  private async writeState(kv: KVNamespace, key: string, state: State) {
    // Separate lease/error keys avoid KV's one-write-per-key-per-second limit.
    const target =
      state.code === "UPDATE_PENDING" ? `${key}:lease` : `${key}:state`;
    try {
      await kv.put(
        target,
        JSON.stringify(state),
        state.retryAt === null
          ? {}
          : {
              expirationTtl:
                state.code === "UPDATE_PENDING"
                  ? 120
                  : Math.max(
                      ttl,
                      Math.ceil((state.retryAt - Date.now()) / 1000),
                    ),
            },
      );
    } catch {
      throw new UnipaError("CACHE_UNAVAILABLE");
    }
  }

  async status() {
    try {
      const { kv, key } = await this.storage();
      const { snapshot, state } = await this.read(kv, key);
      return {
        enabled: true,
        configured: true,
        authenticated: null,
        lastSuccessAt: snapshot?.fetchedAt ?? null,
        stale:
          !snapshot || Date.now() - Date.parse(snapshot.fetchedAt) >= freshMs,
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

  async list() {
    const config = await this.storage();
    const { snapshot, state } = await this.read(config.kv, config.key);
    if (snapshot && Date.now() - Date.parse(snapshot.fetchedAt) < freshMs)
      return this.result(snapshot, false, []);
    let pending = inFlight.get(config.kv);
    if (!pending) {
      pending = new Map();
      inFlight.set(config.kv, pending);
    }
    let update = pending.get(config.key);
    const blocked =
      state && (state.retryAt === null || state.retryAt > Date.now());
    if (blocked && !update) {
      if (snapshot) return this.result(snapshot, true, [state.code]);
      throw new UnipaError(state.code);
    }
    if (!update) {
      update = (async () => {
        // KV is not a distributed lock. This lease limits ordinary duplicate refreshes.
        await this.writeState(config.kv, config.key, {
          code: "UPDATE_PENDING",
          retryAt: Date.now() + 120_000,
        });
        try {
          const result = await collectNotices(
            config,
            this.signal,
            this.transport,
          );
          try {
            await config.kv.put(config.key, JSON.stringify(result), {
              expirationTtl: ttl,
            });
            await config.kv.delete(`${config.key}:state`);
          } catch {
            throw new UnipaError("CACHE_UNAVAILABLE");
          }
          return result;
        } catch (error) {
          const safe = safeError(error);
          if (safe.code !== "CACHE_UNAVAILABLE")
            await this.writeState(config.kv, config.key, {
              code: safe.code as State["code"],
              retryAt: permanentFailure(safe.code)
                ? null
                : Date.now() + safe.retryAfterSeconds * 1000,
            });
          throw safe;
        }
      })();
      pending.set(config.key, update);
    }
    try {
      return this.result(await update, false, []);
    } catch (error) {
      if (snapshot) return this.result(snapshot, true, [safeError(error).code]);
      throw safeError(error);
    } finally {
      if (pending.get(config.key) === update) pending.delete(config.key);
    }
  }
  private result(snapshot: Snapshot, stale: boolean, warnings: ErrorCode[]) {
    return {
      ...snapshot,
      cacheExpiresAt: new Date(
        Date.parse(snapshot.fetchedAt) + freshMs,
      ).toISOString(),
      stale,
      warnings,
      officialUrl: UNIPA_PORTAL,
    };
  }
}
