import {
  ajaxConfig,
  ajaxFields,
  applyPartial,
  assertAuthenticated,
  assertNoAuthChallenge,
  form,
  html,
  text,
  type HtmlDocument,
  type HtmlElement,
} from "./jsf";
import { UnipaSession, type Transport } from "./session";
import { UNIPA_PORTAL, UnipaError, type Notice, type Snapshot } from "./types";

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function allTab(doc: HtmlDocument) {
  const tab = Array.from(doc.querySelectorAll('[role="tab"]')).find(
    (e) => text(e) === "全表示",
  );
  const panelId = tab?.querySelector("a")?.getAttribute("href")?.slice(1);
  if (!panelId) throw new UnipaError("FORMAT_CHANGED");
  const state = Array.from(
    doc.querySelectorAll('input[name$="_activeIndex"]'),
  ).find((e) =>
    panelId.startsWith(
      (e.getAttribute("name") ?? "").replace(/_activeIndex$/, "") + ":",
    ),
  );
  if (!state) throw new UnipaError("FORMAT_CHANGED");
  const source = state.getAttribute("name")!.replace(/_activeIndex$/, "");
  const tabList = Array.from(
    doc.getElementById(source)?.querySelectorAll('[role="tab"]') ?? [],
  ).filter((e) => e.querySelector('a[href^="#"]'));
  const index = tabList.indexOf(tab!);
  if (index < 0 || !doc.getElementById(panelId))
    throw new UnipaError("FORMAT_CHANGED");
  return {
    source,
    panelId,
    index,
    selected: state.getAttribute("value") === String(index),
  };
}

function targetUpdates(
  config: Record<string, string>,
  fallback: string,
): string[] {
  const targets = (config.u ?? fallback)
    .split(/\s+/)
    .filter((v) => v === "funcForm" || v.startsWith("funcForm:"));
  if (!targets.length) throw new UnipaError("FORMAT_CHANGED");
  return targets;
}

export async function parseNotices(panel: HtmlElement): Promise<Notice[]> {
  const rows = Array.from(panel.querySelectorAll("dl.keiji"));
  if (rows.length > 1000) throw new UnipaError("INCOMPLETE_LIST");
  const occurrences = new Map<string, number>();
  const notices: Notice[] = [];
  for (const row of rows) {
    const category = text(
      row.querySelector(".keijiCategory") ?? { textContent: "" },
    );
    const anchor = row.querySelector("a.ui-commandlink");
    if (!anchor) throw new UnipaError("FORMAT_CHANGED");
    const title = text(anchor);
    // Sender/date are the direct text following the title, never its detail link.
    let metadata = "";
    for (let node = anchor.nextSibling; node; node = node.nextSibling)
      if (node.nodeType === 3) metadata += node.textContent ?? "";
    const match = metadata
      .replace(/\s+/g, " ")
      .trim()
      .match(/^\[([^\]]+)\]\s*(\d{4})\/(\d{2})\/(\d{2})$/);
    if (
      !match ||
      !title ||
      title.length > 2000 ||
      category.length > 256 ||
      match[1]!.length > 256
    )
      throw new UnipaError("FORMAT_CHANGED");
    const postedDate = `${match[2]}-${match[3]}-${match[4]}`;
    const date = new Date(`${postedDate}T00:00:00Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== postedDate
    )
      throw new UnipaError("FORMAT_CHANGED");
    const sender = match[1]!.trim();
    const controls = row.nextElementSibling;
    const labels = controls
      ? Array.from(controls.querySelectorAll("*")).map(text)
      : [];
    const unread =
      labels.includes("既読にする") === labels.includes("未読にする")
        ? null
        : labels.includes("既読にする");
    const fingerprint = await digest(
      JSON.stringify([title, category, sender, postedDate]),
    );
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    notices.push({
      id: `${fingerprint}:${occurrence}`,
      source: "unipa",
      title,
      category,
      sender,
      postedDate,
      unread,
      important: Boolean(row.querySelector(".fa-exclamation-circle")),
      officialUrl: UNIPA_PORTAL,
    });
  }
  return notices;
}

export async function collectNotices(
  credentials: { userId: string; password: string },
  signal?: AbortSignal,
  transport?: Transport,
): Promise<Snapshot> {
  return (await collectNoticeBoard(credentials, signal, transport)).snapshot;
}

// Ephemeral collector context only: never serialize DOM, session or form state.
export async function collectNoticeBoard(
  credentials: { userId: string; password: string },
  signal?: AbortSignal,
  transport?: Transport,
) {
  const session = new UnipaSession(signal, transport);
  let page = await session.request(UNIPA_PORTAL);
  let doc = html(page.body);
  assertNoAuthChallenge(doc);
  const login = form(doc, "loginForm", page.url);
  const user = doc
    .querySelector('#loginForm input[type="text"][name$=":userId"]')
    ?.getAttribute("name");
  const password = doc
    .querySelector('#loginForm input[type="password"][name$=":password"]')
    ?.getAttribute("name");
  const button = Array.from(
    doc
      .getElementById("loginForm")!
      .querySelectorAll("button,input[type=submit]"),
  ).find((e) => text(e) === "LOGIN" || e.getAttribute("value") === "LOGIN");
  const buttonName = button?.getAttribute("name");
  if (!user || !password || !buttonName) throw new UnipaError("FORMAT_CHANGED");
  login.fields.set(user, credentials.userId);
  login.fields.set(password, credentials.password);
  login.fields.set(buttonName, buttonName);
  page = await session.request(login.action, login.fields);
  doc = html(page.body);
  const menu = doc.getElementById("menuForm");
  assertNoAuthChallenge(doc);
  if (
    doc.getElementById("loginForm") ||
    doc.querySelector('input[type="password"]')
  )
    throw new UnipaError("AUTH_REJECTED");
  assertAuthenticated(doc);
  const board = Array.from(menu?.querySelectorAll("a") ?? []).find(
    (e) => text(e) === "掲示板",
  );
  const command =
    board?.getAttribute("data-pfconfirmcommand") ??
    board?.getAttribute("onclick") ??
    "";
  const source = command.match(/syncTransition\(['"]([^'"]+)['"]\)/)?.[1];
  if (!source?.startsWith("menuForm:")) throw new UnipaError("FORMAT_CHANGED");
  const selection = command.match(
    /PrimeFaces\.addSubmitParam\(['"]menuForm['"],\s*\{([^{}]+)\}\)/,
  )?.[1];
  if (!selection) throw new UnipaError("FORMAT_CHANGED");
  const values = [
    ...selection.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g),
  ];
  const state = form(doc, "menuForm", page.url);
  for (const entry of values) {
    if (entry[1] !== source && entry[1] !== `${source}_menuid`)
      throw new UnipaError("FORMAT_CHANGED");
    state.fields.set(entry[1]!, entry[2]!);
  }
  if (
    state.fields.get(source) !== source ||
    !state.fields.get(`${source}_menuid`)
  )
    throw new UnipaError("FORMAT_CHANGED");
  state.fields.set("rx.sync.source", source);
  page = await session.request(state.action, state.fields);
  doc = html(page.body);
  assertAuthenticated(doc);
  let tab = allTab(doc);
  if (!tab.selected) {
    const script = Array.from(doc.querySelectorAll("script"))
      .map((e) => e.textContent ?? "")
      .join("\n");
    const config = ajaxConfig(script, tab.source, "tabChange");
    const action = ajaxFields(doc, page.url, tab.source, config);
    action.fields.set("javax.faces.behavior.event", "tabChange");
    action.fields.set("javax.faces.partial.event", "tabChange");
    action.fields.set(`${tab.source}_newTab`, tab.panelId);
    action.fields.set(`${tab.source}_tabindex`, String(tab.index));
    action.fields.set(`${tab.source}_activeIndex`, String(tab.index));
    const response = await session.request(action.action, action.fields, true);
    doc = applyPartial(doc, response, targetUpdates(config, tab.source));
    page = { ...page, url: response.url };
    // A partial panel update may not include tab headers; original IDs remain valid.
    const index = doc.querySelector(`input[name="${tab.source}_activeIndex"]`);
    index?.setAttribute("value", String(tab.index));
  }
  const panel = doc.getElementById(tab.panelId);
  if (!panel) throw new UnipaError("FORMAT_CHANGED");
  const buttons = Array.from(panel.querySelectorAll("button,a")).filter(
    (e) => text(e) === "すべて表示する",
  );
  if (buttons.length > 1) throw new UnipaError("FORMAT_CHANGED");
  if (buttons.length) {
    const button = buttons[0]!;
    const source = button.getAttribute("id");
    if (!source?.startsWith("funcForm:"))
      throw new UnipaError("FORMAT_CHANGED");
    const config = ajaxConfig(button.getAttribute("onclick") ?? "", source);
    const action = ajaxFields(doc, page.url, source, config);
    // PrimeFaces command buttons send an operation marker in addition to source.
    action.fields.set(source, source);
    doc = applyPartial(
      doc,
      await session.request(action.action, action.fields, true),
      targetUpdates(config, source),
    );
  }
  const completePanel = doc.getElementById(tab.panelId);
  if (!completePanel) throw new UnipaError("FORMAT_CHANGED");
  const counts = [...text(completePanel).matchAll(/全\s*(\d+)\s*件/g)].map(
    (m) => Number(m[1]),
  );
  const unique = [...new Set(counts)];
  const notices = await parseNotices(completePanel);
  const zero =
    /掲示(?:情報)?はありません|該当する(?:掲示|データ).*ありません/.test(
      text(completePanel),
    );
  const total =
    unique.length === 1 ? unique[0]! : !unique.length && zero ? 0 : -1;
  if (
    total < 0 ||
    total > 1000 ||
    notices.length !== total ||
    (total === 0 && !zero && unique[0] !== 0)
  )
    throw new UnipaError("INCOMPLETE_LIST");
  const snapshot: Snapshot = {
    schemaVersion: 1,
    fetchedAt: new Date(Date.now()).toISOString(),
    totalCount: total,
    complete: true,
    notices,
  };
  return { snapshot, session, doc, pageUrl: page.url, panelId: tab.panelId };
}
