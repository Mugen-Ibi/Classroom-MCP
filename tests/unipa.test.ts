import { describe, expect, it, vi } from "vitest";
import { collectNotices, parseNotices } from "../src/unipa/notices";
import { UnipaSession, unipaUrl, type Transport } from "../src/unipa/session";
import { applyPartial, form, html } from "../src/unipa/jsf";
import { scheduleChanges } from "../src/unipa/changes";
import { UnipaService } from "../src/unipa/snapshot";
import { UNIPA_PORTAL } from "../src/unipa/types";
import type { Env, GoogleAccess } from "../src/types";
import {
  allId,
  boardHtml,
  loginHtml,
  moreId,
  panelId,
  partial,
  portalHtml,
  rows,
  tabId,
} from "./unipa-fixtures";

const credentials = {
  userId: "synthetic-student-id",
  password: "synthetic-password",
};
const owner: GoogleAccess = {
  userId: "owner-sub",
  email: "student@example.com",
  accessToken: "synthetic-google-token",
  expiresAt: Date.now() + 3600_000,
};
function scriptedFlow(
  options: { login?: string; tab?: string; more?: string; board?: string } = {},
) {
  let step = 0;
  const requests: {
    url: string;
    fields: URLSearchParams;
    cookie: string | null;
  }[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const fields = new URLSearchParams(String(init?.body ?? ""));
      requests.push({
        url,
        fields,
        cookie: new Headers(init?.headers).get("Cookie"),
      });
      const content = [
        loginHtml,
        options.login ?? portalHtml,
        options.board ?? boardHtml(),
        options.tab ??
          partial(
            [
              [
                "funcForm",
                html(boardHtml(15, 38, true)).getElementById("funcForm")!
                  .outerHTML as string,
              ],
            ],
            "synthetic-tab-state",
          ),
        options.more ??
          partial([
            [allId, `<div id="${allId}">${rows(38)}</div>`],
            [moreId, ""],
          ]),
      ][step++];
      if (!content) throw new Error("Unexpected or forbidden request");
      return new Response(content, {
        headers: {
          "Set-Cookie":
            step === 1
              ? "JSESSIONID=synthetic-session; Path=/uprx; Secure; HttpOnly"
              : "unrelated=x; Path=/other; Secure",
        },
      });
    },
  );
  return { transport: fetcher as unknown as Transport, fetcher, requests };
}
function memoryKv() {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const kv = {
    async get(key: string, type?: string) {
      calls.push(`get:${key}`);
      const value = values.get(key);
      return value === undefined
        ? null
        : type === "json"
          ? JSON.parse(value)
          : value;
    },
    async put(key: string, value: string) {
      calls.push(`put:${key}`);
      values.set(key, value);
    },
    async delete(key: string) {
      calls.push(`delete:${key}`);
      values.delete(key);
    },
  } as unknown as KVNamespace;
  const env = {
    ALLOWED_EMAILS: owner.email,
    UNIPA_USER_ID: credentials.userId,
    UNIPA_PASSWORD: credentials.password,
    UNIPA_SNAPSHOTS: kv,
  } as Env;
  return { values, calls, kv, env };
}

describe("UNIPA safe list collection", () => {
  it.each([false, true])(
    "applies ViewState after a form replacement, including omitted inputs (%s)",
    async (omitInput) => {
      let formMarkup = html(boardHtml(15, 38, true)).getElementById("funcForm")!
        .outerHTML as string;
      if (omitInput)
        formMarkup = formMarkup.replace(
          /<input[^>]*name="javax.faces.ViewState"[^>]*>/,
          "",
        );
      const flow = scriptedFlow({
        tab: `<partial-response><changes><update id="javax.faces.ViewState"><![CDATA[synthetic-first-state]]></update><update id="funcForm"><![CDATA[${formMarkup}]]></update></changes></partial-response>`,
      });
      expect(
        (await collectNotices(credentials, undefined, flow.transport))
          .totalCount,
      ).toBe(38);
      expect(flow.requests[4]!.fields.get("javax.faces.ViewState")).toBe(
        "synthetic-first-state",
      );
    },
  );
  it("does not treat notice text about authentication as an authentication challenge", async () => {
    const flow = scriptedFlow({
      login: portalHtml.replace(
        "</body>",
        "<p>大学から認証コードと多要素認証についてのお知らせ</p></body>",
      ),
      board: boardHtml(2, 2, true, false).replace(
        "休講のお知らせ",
        "セッションが終了した場合は再度ログインしてください",
      ),
    });
    expect(
      (await collectNotices(credentials, undefined, flow.transport)).totalCount,
    ).toBe(2);
  });
  it("logs in, follows dynamic menu/tab IDs and rotated states, reads all rows without read/detail actions", async () => {
    const flow = scriptedFlow();
    const result = await collectNotices(credentials, undefined, flow.transport);
    expect(result.totalCount).toBe(38);
    expect(result.notices.filter((n) => n.unread)).toHaveLength(19);
    expect(result.notices.filter((n) => n.unread === false)).toHaveLength(19);
    expect(new Set(result.notices.map((n) => n.id)).size).toBe(38);
    expect(result.notices[0]!.important).toBe(true);
    expect(result.notices[0]!.postedDate).toBe("2026-10-06");
    expect(flow.requests).toHaveLength(5);
    expect(flow.requests[1]!.fields.get("loginForm:password")).toBe(
      credentials.password,
    );
    expect(flow.requests[2]!.fields.get("rx.sync.source")).toBe(
      "menuForm:dynamicMenu",
    );
    expect(flow.requests[3]!.fields.get(`${tabId}_newTab`)).toBe(panelId);
    expect(flow.requests[4]!.fields.get("javax.faces.ViewState")).toBe(
      "synthetic-tab-state",
    );
    expect(flow.requests[4]!.fields.get(moreId)).toBe(moreId);
    expect(
      flow.requests
        .slice(1)
        .every((r) => r.cookie?.includes("JSESSIONID=synthetic-session")),
    ).toBe(true);
    expect(flow.requests.every((r) => !r.cookie?.includes("unrelated"))).toBe(
      true,
    );
    for (const secret of [
      credentials.userId,
      credentials.password,
      "synthetic-session",
      "synthetic-rx",
      "synthetic-tab-state",
      "FORBIDDEN",
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("accepts an explicit zero count and rejects a partial or missing total", async () => {
    const zero = scriptedFlow({ board: boardHtml(0, 0, true, false) });
    expect(
      (await collectNotices(credentials, undefined, zero.transport)).totalCount,
    ).toBe(0);
    const incomplete = scriptedFlow({ board: boardHtml(2, 38, true, false) });
    await expect(
      collectNotices(credentials, undefined, incomplete.transport),
    ).rejects.toMatchObject({ code: "INCOMPLETE_LIST" });
    const missing = scriptedFlow({
      board: boardHtml(0, 0, true, false).replace("全0件", ""),
    });
    await expect(
      collectNotices(credentials, undefined, missing.transport),
    ).rejects.toMatchObject({ code: "INCOMPLETE_LIST" });
  });
  it.each([
    [
      "root login replacement",
      partial([["javax.faces.ViewRoot", loginHtml]]),
      "SESSION_EXPIRED",
    ],
    ["200 login HTML", loginHtml, "SESSION_EXPIRED"],
    [
      "JSF error",
      "<partial-response><error><error-name>ViewExpiredException</error-name></error></partial-response>",
      "SESSION_EXPIRED",
    ],
    [
      "JSF redirect",
      '<partial-response><redirect url="/uprx/"/></partial-response>',
      "SESSION_EXPIRED",
    ],
    ["only ViewState", partial([]), "FORMAT_CHANGED"],
    [
      "malformed XML",
      '<partial-response><changes><update id="funcForm">broken</changes></partial-response>',
      "FORMAT_CHANGED",
    ],
    [
      "unrelated HTML",
      "<html><body>Temporary service page</body></html>",
      "FORMAT_CHANGED",
    ],
  ])("does not keep old rows after %s", async (_name, response, code) => {
    const flow = scriptedFlow({ tab: response });
    await expect(
      collectNotices(credentials, undefined, flow.transport),
    ).rejects.toMatchObject({ code });
    expect(flow.requests).toHaveLength(4);
  });
  it("rejects a foreign form action before submitting credentials", async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          loginHtml.replace(
            "/uprx/up/pk/pky001/Pky00101.xhtml",
            "https://evil.test/uprx/login.xhtml",
          ),
        ),
    );
    await expect(
      collectNotices(credentials, undefined, transport as unknown as Transport),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps date/room/course unknown and retains duplicate notice candidates", async () => {
    const doc = html(`<div id="panel">${rows(2)}${rows(1)}</div>`);
    const notices = await parseNotices(doc.getElementById("panel")!);
    const changes = scheduleChanges(notices);
    expect(changes).toHaveLength(3);
    expect(
      changes.every(
        (c) =>
          c.effectiveDate === null &&
          c.room === null &&
          c.courseName === null &&
          c.requiresOfficialConfirmation,
      ),
    ).toBe(true);
    expect(changes[0]!.noticeId).not.toBe(changes[2]!.noticeId);
  });
});

describe("UNIPA transport boundaries", () => {
  it.each([
    "https://evil.test/uprx/a.xhtml",
    "https://unipa.i-u.ac.jp/uprx/webapi/login",
    "https://unipa.i-u.ac.jp/uprx/a.xhtml?password=x",
    "https://user:password@unipa.i-u.ac.jp/uprx/a.xhtml",
  ])("rejects unsafe URL %s", (url) => expect(() => unipaUrl(url)).toThrow());
  it("does not forward a credential POST on a foreign 307 redirect", async () => {
    const transport = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://evil.test/uprx/login.xhtml" },
        }),
    );
    await expect(
      new UnipaSession(undefined, transport as unknown as Transport).request(
        UNIPA_PORTAL,
        new URLSearchParams({ password: credentials.password }),
      ),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("limits redirects, body size, and respects Retry-After without replaying POSTs", async () => {
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: "/uprx/" } }),
    );
    await expect(
      new UnipaSession(undefined, redirect as unknown as Transport).request(
        UNIPA_PORTAL,
      ),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    expect(redirect).toHaveBeenCalledTimes(6);
    const large = vi.fn(async () => new Response("x".repeat(4_000_001)));
    await expect(
      new UnipaSession(undefined, large as unknown as Transport).request(
        UNIPA_PORTAL,
      ),
    ).rejects.toMatchObject({ code: "FORMAT_CHANGED" });
    const busy = vi.fn(
      async () =>
        new Response("secret upstream body", {
          status: 429,
          headers: { "Retry-After": "1800" },
        }),
    );
    await expect(
      new UnipaSession(undefined, busy as unknown as Transport).request(
        UNIPA_PORTAL,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 1800 });
    expect(busy).toHaveBeenCalledTimes(1);
  });
  it("rejects a canceled request before networking", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn();
    await expect(
      new UnipaSession(controller.signal, transport).request(UNIPA_PORTAL),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("serializes only hidden state, not unrelated action buttons or passwords", () => {
    const state = form(html(loginHtml), "loginForm", UNIPA_PORTAL);
    expect([...state.fields.keys()]).toEqual([
      "loginForm",
      "javax.faces.ViewState",
    ]);
  });
});

describe("UNIPA owner/cache policy", () => {
  it.each([
    undefined,
    "",
    "student@example.com,other@example.com",
    "other@example.com",
  ])(
    "blocks invalid owner configuration before cache or networking (%s)",
    async (emails) => {
      const store = memoryKv();
      const transport = vi.fn();
      store.env.ALLOWED_EMAILS = emails;
      const service = new UnipaService(store.env, owner, undefined, transport);
      await expect(service.list()).rejects.toMatchObject({
        code: "OWNER_REQUIRED",
      });
      expect((await service.status()).reason).toBe("OWNER_REQUIRED");
      expect(store.calls).toHaveLength(0);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it("blocks a partial credential or missing KV without login", async () => {
    const store = memoryKv();
    delete store.env.UNIPA_PASSWORD;
    const transport = vi.fn();
    await expect(
      new UnipaService(store.env, owner, undefined, transport).list(),
    ).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    expect(store.calls).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();
    store.env.UNIPA_PASSWORD = credentials.password;
    delete store.env.UNIPA_SNAPSHOTS;
    expect((await new UnipaService(store.env, owner).status()).reason).toBe(
      "CONFIG_REQUIRED",
    );
  });
  it("returns fresh cache, status performs no login, and stored data excludes all credentials/states", async () => {
    const store = memoryKv(),
      flow = scriptedFlow();
    const service = new UnipaService(
      store.env,
      owner,
      undefined,
      flow.transport,
    );
    expect((await service.status()).lastSuccessAt).toBe(null);
    expect(flow.fetcher).not.toHaveBeenCalled();
    expect((await service.list()).stale).toBe(false);
    expect((await service.list()).totalCount).toBe(38);
    expect(flow.fetcher).toHaveBeenCalledTimes(5);
    const saved = JSON.stringify([...store.values]);
    for (const secret of [
      credentials.userId,
      credentials.password,
      owner.email,
      owner.accessToken,
      "synthetic-session",
      "synthetic-rx",
      "synthetic-tab-state",
      "javax.faces",
      "loginForm",
    ])
      expect(saved).not.toContain(secret);
  });
  it("keeps the last success stale on failure and does not replace it with zero", async () => {
    const store = memoryKv(),
      flow = scriptedFlow();
    await new UnipaService(store.env, owner, undefined, flow.transport).list();
    const key = [...store.values.keys()].find(
      (k) => !k.endsWith(":lease") && !k.endsWith(":state"),
    )!;
    const prior = JSON.parse(store.values.get(key)!);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    const failed = vi.fn(async () => {
      throw new Error(`private ${credentials.password}`);
    });
    const service = new UnipaService(
      store.env,
      owner,
      undefined,
      failed as unknown as Transport,
    );
    const result = await service.list();
    expect(result.stale).toBe(true);
    expect(result.totalCount).toBe(38);
    expect(result.warnings).toEqual(["NETWORK_ERROR"]);
    expect(store.values.get(key)).toBe(JSON.stringify(prior));
    await service.list();
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it.each([
    [loginHtml, "AUTH_REJECTED"],
    ["<html>認証コードを入力してください</html>", "INTERACTIVE_AUTH_REQUIRED"],
  ])(
    "pauses rejected/interactive authentication until the owner changes revision",
    async (login, code) => {
      const store = memoryKv(),
        flow = scriptedFlow({ login });
      const service = new UnipaService(
        store.env,
        owner,
        undefined,
        flow.transport,
      );
      await expect(service.list()).rejects.toMatchObject({ code });
      await expect(service.list()).rejects.toMatchObject({ code });
      expect(flow.fetcher).toHaveBeenCalledTimes(2);
      expect((await service.status()).automaticRetryPaused).toBe(true);
      store.env.UNIPA_AUTH_REVISION = "2";
      const fixed = scriptedFlow();
      expect(
        (
          await new UnipaService(
            store.env,
            owner,
            undefined,
            fixed.transport,
          ).list()
        ).totalCount,
      ).toBe(38);
    },
  );
  it("shares concurrent refreshes within one isolate", async () => {
    const store = memoryKv(),
      flow = scriptedFlow();
    const [first, second] = await Promise.all([
      new UnipaService(store.env, owner, undefined, flow.transport).list(),
      new UnipaService(store.env, owner, undefined, flow.transport).list(),
    ]);
    expect(first.notices).toEqual(second.notices);
    expect(flow.fetcher).toHaveBeenCalledTimes(5);
  });
  it("persists an immediate auth rejection without multiple writes to the same KV key", async () => {
    const store = memoryKv(),
      flow = scriptedFlow({ login: loginHtml });
    const put = store.kv.put.bind(store.kv);
    const writes = new Set<string>();
    store.kv.put = vi.fn(async (key, value, options) => {
      if (writes.has(key)) throw new Error("Synthetic KV per-key write limit");
      writes.add(key);
      await put(key, value, options);
    });
    const service = new UnipaService(
      store.env,
      owner,
      undefined,
      flow.transport,
    );
    await expect(service.list()).rejects.toMatchObject({
      code: "AUTH_REJECTED",
    });
    expect((await service.status()).automaticRetryPaused).toBe(true);
    expect(writes.size).toBe(2);
  });
  it("does not return expired snapshots or a false empty list after 24 hours", async () => {
    const store = memoryKv(),
      flow = scriptedFlow();
    await new UnipaService(store.env, owner, undefined, flow.transport).list();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 3600_000);
    const failed = vi.fn(async () => {
      throw new Error("Synthetic offline");
    });
    await expect(
      new UnipaService(
        store.env,
        owner,
        undefined,
        failed as unknown as Transport,
      ).list(),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("fails closed before login when the notification KV cannot be read", async () => {
    const store = memoryKv();
    store.kv.get = vi.fn(async () => {
      throw new Error("Synthetic KV outage");
    });
    const transport = vi.fn();
    await expect(
      new UnipaService(store.env, owner, undefined, transport).list(),
    ).rejects.toMatchObject({ code: "CACHE_UNAVAILABLE" });
    expect(transport).not.toHaveBeenCalled();
  });
});
