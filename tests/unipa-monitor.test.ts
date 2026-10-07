import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  UnipaNoticeMonitor,
  type MonitorStore,
  type MonitorPrincipal,
} from "../src/unipa/monitor";
import { collectNoticeBoard } from "../src/unipa/notices";
import { createNoticeBoardBodyReader } from "../src/unipa/detail-reader";
import { acquireImportantBodies } from "../src/unipa/body";
import { noticePollDue, UNIPA_POLL_CRON } from "../src/unipa/polling";
import {
  SubscriptionWebhookTransport,
  validateCallbackUrl,
} from "../src/unipa/webhook";
import { handleNoticeEventRpc } from "../src/unipa/event-rpc";
import type { UnipaBindings } from "../src/unipa/types";
import { loginHtml, portalHtml, boardHtml, partial } from "./unipa-fixtures.js";
import type { Transport } from "../src/unipa/session";

const epoch = Date.parse("2026-10-07T03:00:00Z");
const owner: MonitorPrincipal = {
  userId: "fixture-owner",
  email: "student@example.com",
  grantId: "fixture-grant",
};
const secret = `whsec_${Buffer.from("fixture-only-public-key-material!").toString("base64")}`;
const subscription = {
  name: "unipa.important_notice_detected",
  arguments: {},
  delivery: {
    mode: "webhook",
    url: "https://receiver.example.com/callback",
    secret,
  },
  cursor: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});
afterEach(() => {
  vi.useRealTimers();
});

async function boardFlow(
  title = "休講のお知らせ",
  options: { read?: boolean; command?: string; response?: string } = {},
) {
  const source = "funcForm:dynamicRow:detail";
  const command =
    options.command ??
    `PrimeFaces.ab({s:"${source}",f:"funcForm",p:"${source}",u:"funcForm"});return false;`;
  let boardMarkup = boardHtml(2, 2, true, false).replace(
    '<a class="ui-commandlink" onclick="FORBIDDEN_DETAIL">休講のお知らせ</a>',
    `<a id="${source}" class="ui-commandlink" onclick='${command}'>${title}</a>`,
  );
  if (options.read)
    boardMarkup = boardMarkup.replace("既読にする", "未読にする");
  const detail = `<form id="funcForm" action="/uprx/up/bs/bsd007/Bsd00701.xhtml"><input type="hidden" name="javax.faces.ViewState" value="fixture-detail-state"><table><tr><td>件名</td><td>${title}</td></tr><tr><td>カテゴリ</td><td>合成カテゴリ</td></tr><tr><td>差出人</td><td>合成差出人</td></tr><tr><td>本文</td><td>合成の重要本文。正式画面で確認してください。</td></tr></table></form>`;
  const responses = [
    loginHtml,
    portalHtml,
    boardMarkup,
    options.response ?? partial([["funcForm", detail]]),
  ];
  const requests: URLSearchParams[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    requests.push(new URLSearchParams(String(init?.body ?? "")));
    const content = responses[requests.length - 1];
    if (!content) throw new Error("FORBIDDEN_EXTRA_REQUEST");
    return new Response(content);
  });
  const board = await collectNoticeBoard(
    { userId: "fixture-user", password: "fixture-password" },
    undefined,
    fetcher as Transport,
  );
  return { board, requests, fetcher, source };
}

function setup() {
  let saved: Awaited<ReturnType<MonitorStore["load"]>>;
  const store: MonitorStore = {
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async (value) => {
      saved = structuredClone(value);
    }),
  };
  const wire: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  let status = 202;
  const outbound = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    wire.push({ url, body, headers: new Headers(init.headers) });
    if (body.type === "verification")
      return Response.json({ challenge: body.challenge });
    return new Response("", { status });
  });
  let title = "休講のお知らせ",
    read = false,
    allowed = true,
    revision = "1";
  const collect = vi.fn(async () => (await boardFlow(title, { read })).board);
  const dependencies = {
    store,
    enabled: true,
    bodyEnabled: true,
    backfillEnabled: false,
    allowReadStateChange: true,
    allowedHosts: ["receiver.example.com"],
    revision: () => revision,
    canAccess: vi.fn(
      async (principal: MonitorPrincipal) =>
        allowed &&
        principal.userId === owner.userId &&
        principal.email === owner.email &&
        principal.grantId === owner.grantId,
    ),
    scope: async () => "3".repeat(64),
    collect,
    webhook: new SubscriptionWebhookTransport(
      ["receiver.example.com"],
      outbound,
    ),
  };
  const monitor = new UnipaNoticeMonitor(dependencies);
  return {
    monitor,
    dependencies,
    store,
    wire,
    outbound,
    collect,
    saved: () => structuredClone(saved),
    setTitle: (value: string) => {
      title = value;
    },
    setRead: (value: boolean) => {
      read = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    setRevision: (value: string) => {
      revision = value;
    },
  };
}

describe("HTTP/JSF important detail reader", () => {
  it("uses a live-list dynamic source once, rotated state and only the matched notice", async () => {
    const flow = await boardFlow();
    const source = createNoticeBoardBodyReader(flow.board);
    const results = await acquireImportantBodies(
      [flow.board.snapshot.notices[0]!],
      { enabled: true, allowReadStateChange: true },
      {},
      source,
    );
    expect(results[0]).toMatchObject({
      status: "retrieved",
      unreadAtDetection: true,
      readStateMayHaveChanged: true,
      body: { text: "合成の重要本文。正式画面で確認してください。" },
    });
    expect(flow.requests).toHaveLength(4);
    expect(flow.requests[3]!.get("javax.faces.source")).toBe(flow.source);
    expect(flow.requests[3]!.get("javax.faces.ViewState")).toBe(
      "synthetic-board-state",
    );
    expect(flow.requests[3]!.get(flow.source)).toBe(flow.source);
    await expect(
      source.read(flow.board.snapshot.notices[0]!),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    expect(flow.requests).toHaveLength(4);
    for (const value of [
      "fixture-user",
      "fixture-password",
      "fixture-detail-state",
    ])
      expect(JSON.stringify(results)).not.toContain(value);
  });
  it("supports a same-form full-page transition without executing server JavaScript", async () => {
    const source = "funcForm:dynamicRow:detail";
    const command = `syncTransition("${source}");PrimeFaces.addSubmitParam("funcForm",{"${source}":"${source}"}).submit("funcForm");return false;`;
    const detail = `<form id="funcForm"><table><tr><td>件名</td><td>休講のお知らせ</td></tr><tr><td>カテゴリ</td><td>合成カテゴリ</td></tr><tr><td>差出人</td><td>合成差出人</td></tr><tr><td>本文</td><td>合成本文</td></tr></table></form>`;
    const flow = await boardFlow("休講のお知らせ", {
      command,
      response: detail,
    });
    expect(
      (
        await createNoticeBoardBodyReader(flow.board).read(
          flow.board.snapshot.notices[0]!,
        )
      ).text,
    ).toBe("合成本文");
    expect(flow.requests[3]!.get("rx.sync.source")).toBe(source);
  });
  it.each([
    "FORBIDDEN_DETAIL",
    'PrimeFaces.ab({s:"funcForm:dynamicRow:detail",p:"@all",u:"funcForm"})',
    'PrimeFaces.ab({s:"funcForm:dynamicRow:detail",p:"@this",u:"outsideForm"})',
  ])(
    "fails before POST for an unknown or overly broad command (%s)",
    async (command) => {
      const flow = await boardFlow("休講のお知らせ", { command });
      await expect(
        createNoticeBoardBodyReader(flow.board).read(
          flow.board.snapshot.notices[0]!,
        ),
      ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
      expect(flow.requests).toHaveLength(3);
    },
  );
  it("rejects a session replacement instead of returning stale body or retrying", async () => {
    const flow = await boardFlow("休講のお知らせ", {
      response: partial([["javax.faces.ViewRoot", loginHtml]]),
    });
    const source = createNoticeBoardBodyReader(flow.board);
    await expect(
      source.read(flow.board.snapshot.notices[0]!),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(
      source.read(flow.board.snapshot.notices[0]!),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    expect(flow.requests).toHaveLength(4);
  });
});

describe("persistent monitor lifecycle and mock webhook end-to-end", () => {
  it("bounds callback verification cache from the last actual challenge", async () => {
    const test = setup();
    await test.monitor.subscribe(owner, subscription);
    vi.setSystemTime(epoch + 4 * 60_000);
    await test.monitor.subscribe(owner, subscription);
    expect(test.outbound).toHaveBeenCalledTimes(1);
    vi.setSystemTime(epoch + 5 * 60_000);
    await test.monitor.subscribe(owner, subscription);
    expect(test.outbound).toHaveBeenCalledTimes(2);
  });
  it("purges expired private bodies, secrets, owner and differential metadata without login", async () => {
    const test = setup();
    test.dependencies.backfillEnabled = true;
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    await test.monitor.prepareBackfill(owner, {
      noticeIds: [test.saved()!.snapshot!.notices[0]!.id],
      mode: "queue",
    });
    vi.setSystemTime(epoch + 31 * 24 * 3600_000);
    await test.monitor.purgeExpired();
    const saved = test.saved()!;
    expect(saved.archive).toEqual([]);
    expect(saved.subscriptions).toEqual([]);
    expect(saved.snapshot).toBeUndefined();
    expect(saved.state).toBeUndefined();
    expect(saved.owner).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(test.collect).toHaveBeenCalledTimes(1);
  });
  it("previews selected existing important unread notices and queues bounded backfill without immediate HTTP or old-notice events", async () => {
    const test = setup();
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    const noticeId = test.saved()!.snapshot!.notices[0]!.id;
    const preview = await test.monitor.prepareBackfill(owner, {
      noticeIds: [noticeId],
    });
    expect(preview.mode).toBe("preview");
    expect(test.saved()!.archive).toHaveLength(0);
    expect(test.collect).toHaveBeenCalledTimes(1);
    await expect(
      test.monitor.prepareBackfill(owner, {
        noticeIds: [noticeId],
        mode: "queue",
      }),
    ).rejects.toMatchObject({ reason: "BACKFILL_NOT_ENABLED_OR_SUBSCRIBED" });
    test.dependencies.backfillEnabled = true;
    const queued = await test.monitor.prepareBackfill(owner, {
      noticeIds: [noticeId],
      mode: "queue",
    });
    await test.monitor.prepareBackfill(owner, {
      noticeIds: [noticeId],
      mode: "queue",
    });
    expect(test.saved()!.archive).toHaveLength(1);
    expect(test.collect).toHaveBeenCalledTimes(1);
    await expect(
      test.monitor.prepareBackfill(owner, {
        noticeIds: [noticeId, noticeId],
        mode: "queue",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      test.monitor.prepareBackfill(owner, {
        noticeIds: [test.saved()!.snapshot!.notices[1]!.id],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    vi.setSystemTime(epoch + 5 * 3600_000);
    await test.monitor.poll();
    expect(
      await test.monitor.readBody(owner, queued.items[0]!.eventId),
    ).toMatchObject({
      acquisition: "complete",
      result: { status: "retrieved" },
    });
    expect(test.wire.filter((item) => item.body.name)).toHaveLength(0);
  });
  it("pauses subsequent acquisition when a detail request is rejected, without losing the event", async () => {
    const test = setup();
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    vi.setSystemTime(epoch + 5 * 3600_000);
    const flow = await boardFlow("休講のお知らせ（詳細拒否）");
    const { UnipaError } = await import("../src/unipa/types");
    vi.spyOn(flow.board.session, "request").mockRejectedValue(
      new UnipaError("AUTH_REJECTED"),
    );
    test.collect.mockResolvedValueOnce(flow.board);
    await test.monitor.poll();
    expect((await test.monitor.status(owner)).automaticRetryPaused).toBe(true);
    expect(test.saved()!.archive[0]!.result).toMatchObject({
      status: "failed",
      failure: { code: "AUTH_REJECTED" },
    });
    vi.setSystemTime(epoch + 19 * 3600_000);
    await test.monitor.poll();
    expect(test.collect).toHaveBeenCalledTimes(2);
    expect(test.wire.filter((item) => item.body.name)).toHaveLength(1);
  });
  it("verifies/refreshes/subscribes idempotently, baselines, reads a new body and delivers a short signed event", async () => {
    const test = setup();
    const subscribed = await test.monitor.subscribe(owner, subscription);
    expect(test.wire[0]!.body.type).toBe("verification");
    expect(test.wire[0]!.headers.get("webhook-signature")).toMatch(/^v1,/);
    expect(JSON.stringify(subscribed)).not.toContain(secret);
    await test.monitor.poll();
    expect(test.collect).toHaveBeenCalledTimes(1);
    expect(test.wire).toHaveLength(1); // Baseline: no application event or body acquisition.
    const refreshed = await test.monitor.subscribe(owner, subscription);
    expect(refreshed.id).toBe(subscribed.id);
    expect(test.saved()!.subscriptions).toHaveLength(1);
    vi.setSystemTime(epoch + 5 * 3600_000);
    test.setTitle("休講のお知らせ（訂正）");
    await test.monitor.poll();
    const event = test.wire.find(
      (item) => item.body.name === "unipa.important_notice_detected",
    )!;
    expect(event).toBeDefined();
    expect(event.headers.get("webhook-id")).toBe(event.body.eventId);
    expect(JSON.stringify(event.body)).not.toContain("合成の重要本文");
    const body = await test.monitor.readBody(
      owner,
      event.body.eventId as string,
    );
    expect(body).toMatchObject({
      unreadAtDetection: true,
      acquisition: "complete",
      result: { status: "retrieved", readStateMayHaveChanged: true },
    });
    test.setRead(true);
    vi.setSystemTime(epoch + 19 * 3600_000);
    await test.monitor.poll();
    expect(test.wire.filter((item) => item.body.name)).toHaveLength(1);
    const restarted = new UnipaNoticeMonitor(test.dependencies);
    expect(
      await restarted.readBody(owner, event.body.eventId as string),
    ).toEqual(body);
    await restarted.unsubscribe(owner, subscribed.id);
    await restarted.unsubscribe(owner, subscribed.id);
    expect(await restarted.poll()).toMatchObject({ status: "no_subscription" });
    expect(JSON.stringify(await restarted.status(owner))).not.toContain(secret);
  });
  it("persists before read and keeps failed delivery pending after upstream notice becomes read", async () => {
    const test = setup();
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    vi.setSystemTime(epoch + 5 * 3600_000);
    test.setTitle("休講のお知らせ（新規）");
    test.setStatus(500);
    await test.monitor.poll();
    const state = test.saved()!;
    expect(state.subscriptions[0]!.outbox[0]!.status).toBe("pending");
    expect(state.archive[0]!.result?.status).toBe("retrieved");
    test.setRead(true);
    test.setStatus(202);
    vi.setSystemTime(epoch + 5 * 3600_000 + 31_000);
    await new UnipaNoticeMonitor(test.dependencies).poll();
    expect(test.saved()!.subscriptions[0]!.outbox[0]!.status).toBe("accepted");
    expect(test.collect).toHaveBeenCalledTimes(2); // Retry does not log in again before interval.
    const events = test.wire.filter((item) => item.body.name);
    expect(events).toHaveLength(2);
    expect(events[0]!.body.eventId).toBe(events[1]!.body.eventId);
  });
  it("does not log in on event discovery/status/cached body lookup or without a subscription", async () => {
    const test = setup();
    expect((await test.monitor.listEvents(owner)).events).toHaveLength(1);
    await test.monitor.status(owner);
    await test.monitor.readBody(owner, "f".repeat(64));
    await test.monitor.poll();
    expect(test.collect).not.toHaveBeenCalled();
    expect(test.outbound).not.toHaveBeenCalled();
  });
  it("blocks cross-owner access and removes revoked or expired subscriptions before login/delivery", async () => {
    const test = setup();
    await expect(
      test.monitor.subscribe(
        { ...owner, email: "other@example.com" },
        subscription,
      ),
    ).rejects.toMatchObject({ code: -32001 });
    await test.monitor.subscribe(owner, {
      ...subscription,
      ttlMs: 15 * 60_000,
    });
    test.setAllowed(false);
    await test.monitor.poll();
    expect(test.saved()!.subscriptions).toEqual([]);
    expect(test.collect).not.toHaveBeenCalled();
    test.setAllowed(true);
    await test.monitor.subscribe(owner, {
      ...subscription,
      ttlMs: 15 * 60_000,
    });
    vi.setSystemTime(epoch + 5 * 3600_000);
    await test.monitor.poll();
    expect(test.saved()!.subscriptions).toEqual([]);
    expect(test.collect).not.toHaveBeenCalled();
  });
  it("keeps an auth rejection paused until revision changes without exposing upstream failures", async () => {
    const test = setup();
    const { UnipaError } = await import("../src/unipa/types");
    test.collect.mockRejectedValueOnce(new UnipaError("AUTH_REJECTED"));
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    vi.setSystemTime(epoch + 19 * 3600_000);
    await test.monitor.poll();
    expect(test.collect).toHaveBeenCalledTimes(1);
    expect((await test.monitor.status(owner)).automaticRetryPaused).toBe(true);
    test.setRevision("2");
    await test.monitor.poll();
    expect(test.collect).toHaveBeenCalledTimes(2);
    expect((await test.monitor.status(owner)).automaticRetryPaused).toBe(false);
  });
  it("rejects callback failure/unsafe destinations without saving a subscription", async () => {
    const test = setup();
    test.outbound.mockResolvedValueOnce(Response.json({ challenge: "wrong" }));
    await expect(
      test.monitor.subscribe(owner, subscription),
    ).rejects.toMatchObject({ code: -32015 });
    expect(test.saved()).toBeUndefined();
    await expect(
      test.monitor.subscribe(owner, {
        ...subscription,
        delivery: {
          ...subscription.delivery,
          url: "https://127.0.0.1/callback",
        },
      }),
    ).rejects.toMatchObject({ code: -32015 });
    expect(test.outbound).toHaveBeenCalledTimes(1);
  });
  it.each([
    "http://receiver.example.com/x",
    "https://receiver.example.com.evil.test/x",
    "https://user:pass@receiver.example.com/x",
    "https://receiver.example.com/x#fragment",
    "https://receiver.example.com:444/x",
  ])("rejects unsafe callback URL %s", (url) =>
    expect(() => validateCallbackUrl(url, ["receiver.example.com"])).toThrow(
      "CALLBACK_INVALID",
    ),
  );
  it("dual-signs during secret rotation and does not disclose either key", async () => {
    const test = setup();
    await test.monitor.subscribe(owner, subscription);
    await test.monitor.poll();
    const replacement = `whsec_${Buffer.from("fixture-replacement-public-key!!!").toString("base64")}`;
    vi.setSystemTime(epoch + 5 * 3600_000);
    await test.monitor.subscribe(owner, {
      ...subscription,
      delivery: { ...subscription.delivery, secret: replacement },
    });
    test.setTitle("休講の新規お知らせ");
    await test.monitor.poll();
    const event = test.wire.find((item) => item.body.name)!;
    expect(event.headers.get("webhook-signature")!.split(" ")).toHaveLength(2);
    expect(JSON.stringify(await test.monitor.status(owner))).not.toContain(
      replacement,
    );
  });
});

describe("authenticated endpoint event extension dispatch", () => {
  it("routes discover/list/subscribe/unsubscribe through the persistent monitor and leaves ordinary tools to the SDK", async () => {
    const test = setup();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      const path = new URL(url).pathname;
      const result =
        path === "/events/list"
          ? await test.monitor.listEvents(input.owner)
          : path === "/events/subscribe"
            ? await test.monitor.subscribe(input.owner, input.arguments)
            : await test.monitor.unsubscribeRequest(
                input.owner,
                input.arguments,
              );
      return Response.json({ result });
    });
    const env = {
      UNIPA_MONITOR_ENABLED: "true",
      UNIPA_USER_ID: "fixture-user",
      UNIPA_PASSWORD: "fixture-password",
      UNIPA_WEBHOOK_EGRESS: {},
      UNIPA_EVENT_CALLBACK_HOSTS: "receiver.example.com",
      UNIPA_MONITOR: {
        idFromName: () => "fixture",
        get: () => ({ fetch: fetcher }),
      },
    } as unknown as UnipaBindings;
    const request = (method: string, params: unknown = {}) =>
      new Request("https://worker.example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...(params as object),
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const discovered = await (await handleNoticeEventRpc(
      request("server/discover"),
      env,
      owner,
    ))!.json();
    expect(discovered.result.capabilities.events).toEqual({});
    const listed = await (await handleNoticeEventRpc(
      request("events/list"),
      env,
      owner,
    ))!.json();
    expect(listed.result.events[0].name).toBe(subscription.name);
    const subscribed = await (await handleNoticeEventRpc(
      request("events/subscribe", subscription),
      env,
      owner,
    ))!.json();
    expect(subscribed.result.id).toMatch(/^[a-f0-9]{64}$/);
    const removed = await (await handleNoticeEventRpc(
      request("events/unsubscribe", {
        name: subscription.name,
        arguments: {},
        delivery: { mode: "webhook", url: subscription.delivery.url },
      }),
      env,
      owner,
    ))!.json();
    expect(removed.result).toEqual({});
    const beforeRejected = fetcher.mock.calls.length;
    const missingEnvelope = request("events/list");
    const malformed = JSON.parse(await missingEnvelope.clone().text());
    delete malformed.params._meta;
    const rejectedEnvelope = await handleNoticeEventRpc(
      new Request(missingEnvelope.url, {
        method: "POST",
        headers: missingEnvelope.headers,
        body: JSON.stringify(malformed),
      }),
      env,
      owner,
    );
    expect(rejectedEnvelope!.status).toBe(400);
    expect((await rejectedEnvelope!.json()).error.code).toBe(-32602);
    const mismatched = request("events/list");
    mismatched.headers.set("Mcp-Method", "events/unsubscribe");
    const rejectedHeaders = await handleNoticeEventRpc(mismatched, env, owner);
    expect(rejectedHeaders!.status).toBe(400);
    expect((await rejectedHeaders!.json()).error.code).toBe(-32020);
    expect(fetcher.mock.calls.length).toBe(beforeRejected);
    expect(
      await handleNoticeEventRpc(request("tools/list"), env, owner),
    ).toBeNull();
    expect(
      await handleNoticeEventRpc(
        request("events/list"),
        { ...env, UNIPA_MONITOR_ENABLED: "false" },
        owner,
      ),
    ).toBeNull();
    expect(
      JSON.stringify([discovered, listed, subscribed, removed]),
    ).not.toContain(secret);
  });
});
