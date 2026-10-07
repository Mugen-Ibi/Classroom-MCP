import { DOMParser } from "linkedom/worker";
import { XMLValidator } from "fast-xml-parser";
import type { Page } from "./session";
import { unipaUrl } from "./session";
import { UnipaError } from "./types";

// A small inert-DOM surface avoids mixing browser DOM globals with Workers types.
export interface HtmlElement {
  textContent: string | null;
  tagName: string;
  nodeType: number;
  nextSibling: HtmlElement | null;
  nextElementSibling: HtmlElement | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): HtmlElement | null;
  querySelectorAll(selector: string): HtmlElement[];
  contains(element: HtmlElement): boolean;
  replaceWith(element: HtmlElement): void;
  remove(): void;
  appendChild(element: HtmlElement): void;
}
export interface HtmlDocument extends HtmlElement {
  documentElement: HtmlElement;
  getElementById(id: string): HtmlElement | null;
  createElement(tag: string): HtmlElement;
}
export const html = (body: string): HtmlDocument =>
  new DOMParser().parseFromString(body, "text/html") as unknown as HtmlDocument;
export const text = (node: {
  textContent: string | null;
  documentElement?: HtmlElement;
}) =>
  (node.textContent ?? node.documentElement?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

// Exclude samples only within a structurally identified notice detail body.
// Portal form IDs alone never exempt authentication controls.
function noticeBodyCells(doc: HtmlDocument): HtmlElement[] {
  const rows = doc.querySelectorAll("tr");
  const labelledRows = (label: string) =>
    rows.filter(
      (row) =>
        text(
          row.querySelector("td:first-child label") ??
            row.querySelector("td:first-child") ?? { textContent: "" },
        ) === label,
    );
  if (
    !["件名", "カテゴリ", "差出人", "本文"].every(
      (label) => labelledRows(label).length === 1,
    )
  )
    return [];
  const body = labelledRows("本文")[0]!.querySelector("td:nth-child(2)");
  return body ? [body] : [];
}

// Authentication controls are state signals; words inside a notice are not.
// Parse inert DOM only, and never return the challenge or attempt to solve it.
export function assertNoAuthChallenge(doc: HtmlDocument): void {
  const bodies = noticeBodyCells(doc);
  const outsideBody = (element: HtmlElement) =>
    !bodies.some((body) => body.contains(element));
  if (
    doc
      .querySelectorAll("#cf-error-details, #accessDenied, #access-denied")
      .some(outsideBody)
  )
    throw new UnipaError("AUTH_REJECTED");
  if (
    doc
      .querySelectorAll(
        '.g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, [id^="cf-chl-"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
      )
      .some(outsideBody)
  )
    throw new UnipaError("INTERACTIVE_AUTH_REQUIRED");
  const authName =
    /(?:^|[:_-])(?:otp|totp|mfa|captcha|verification.?code|authentication.?code)(?:$|[:_-])/i;
  if (
    doc
      .querySelectorAll("input")
      .some(
        (input) =>
          outsideBody(input) &&
          (input.getAttribute("autocomplete") === "one-time-code" ||
            authName.test(input.getAttribute("name") ?? "") ||
            authName.test(input.getAttribute("id") ?? "")),
      )
  )
    throw new UnipaError("INTERACTIVE_AUTH_REQUIRED");
  for (const element of doc.querySelectorAll("form").filter(outsideBody)) {
    const identity = ["id", "name", "action"]
      .map((attribute) => element.getAttribute(attribute) ?? "")
      .join(" ");
    const authForm =
      /mfa|two.?factor|multi.?factor|one.?time|\botp|totp|captcha|challenge/i.test(
        identity,
      );
    if (authForm && element.querySelectorAll("input, button").some(outsideBody))
      throw new UnipaError("INTERACTIVE_AUTH_REQUIRED");
  }
}

export function assertAuthenticated(doc: HtmlDocument): void {
  assertNoAuthChallenge(doc);
  const bodies = noticeBodyCells(doc);
  if (
    doc
      .querySelectorAll('input[type="password"], #loginForm')
      .some((element) => !bodies.some((body) => body.contains(element)))
  )
    throw new UnipaError("SESSION_EXPIRED");
  // A notice mentioning login/session problems is data, not an auth-state signal.
  if (doc.querySelector("#menuForm, #funcForm, dl.keiji")) return;
  const copy = text(doc);
  if (
    /セッション.*(?:切れ|終了|無効)|ログアウトしました|再度ログイン/.test(copy)
  )
    throw new UnipaError("SESSION_EXPIRED");
}

export function form(doc: HtmlDocument, id: string, pageUrl: string) {
  const element = doc.getElementById(id);
  if (!element || element.tagName !== "FORM")
    throw new UnipaError("FORMAT_CHANGED");
  const fields = new URLSearchParams();
  for (const input of element.querySelectorAll("input")) {
    const name = input.getAttribute("name");
    if (
      !name ||
      input.hasAttribute("disabled") ||
      input.getAttribute("type") !== "hidden"
    )
      continue;
    fields.append(name, input.getAttribute("value") ?? "");
  }
  // Only hidden state is reused. Never serialize unrelated action controls.
  if (!fields.get("javax.faces.ViewState"))
    throw new UnipaError("FORMAT_CHANGED");
  if (!fields.has(id)) fields.set(id, id);
  return {
    fields,
    action: unipaUrl(element.getAttribute("action") ?? pageUrl, pageUrl),
  };
}

// Parse only string fields from PrimeFaces.ab metadata. Never evaluate server scripts.
export function ajaxConfig(script: string, source: string, event?: string) {
  const configs = [...script.matchAll(/PrimeFaces\.ab\(\{([^{}]*)\}/g)];
  for (const match of configs) {
    const values: Record<string, string> = {};
    for (const entry of match[1]!.matchAll(
      /\b(s|e|f|p|u)\s*:\s*(["'])([^"']*)\2/g,
    ))
      values[entry[1]!] = entry[3]!;
    if (values.s === source && (!event || values.e === event)) return values;
  }
  throw new UnipaError("FORMAT_CHANGED");
}

export function ajaxFields(
  doc: HtmlDocument,
  pageUrl: string,
  source: string,
  config: Record<string, string>,
) {
  const state = form(doc, "funcForm", pageUrl);
  state.fields.set("javax.faces.partial.ajax", "true");
  state.fields.set("javax.faces.source", source);
  state.fields.set("javax.faces.partial.execute", config.p ?? source);
  if (config.u) state.fields.set("javax.faces.partial.render", config.u);
  return state;
}

export function applyPartial(
  doc: HtmlDocument,
  response: Page,
  expected: string[],
): HtmlDocument {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<partial-response\b/.test(response.body)) {
    const candidate = html(response.body);
    assertAuthenticated(candidate);
    throw new UnipaError("FORMAT_CHANGED");
  }
  if (XMLValidator.validate(response.body) !== true)
    throw new UnipaError("FORMAT_CHANGED");
  const xml = new DOMParser().parseFromString(
    response.body,
    "text/xml",
  ) as unknown as HtmlDocument;
  if (xml.querySelector("error")) throw new UnipaError("SESSION_EXPIRED");
  if (xml.querySelector("redirect")) throw new UnipaError("SESSION_EXPIRED");
  const updates = Array.from(xml.querySelectorAll("update"));
  // A root replacement must be classified before looking at the previous DOM.
  const root = updates.find(
    (u) => u.getAttribute("id") === "javax.faces.ViewRoot",
  );
  if (root) {
    const replacement = html(root.textContent ?? "");
    assertAuthenticated(replacement);
    throw new UnipaError("FORMAT_CHANGED");
  }
  let changed = false,
    viewState: string | undefined;
  for (const update of updates) {
    const id = update.getAttribute("id") ?? "";
    if (/(?:^|:)javax\.faces\.ViewState(?::\d+)?$/.test(id)) {
      const value = update.textContent ?? "";
      if (!value.trim() || (viewState !== undefined && viewState !== value))
        throw new UnipaError("FORMAT_CHANGED");
      viewState = value;
    } else {
      // Challenge HTML may arrive at an unexpected update target. Classify it
      // before checking render IDs, rather than retaining the old portal DOM.
      const fragment = html(update.textContent ?? "");
      assertAuthenticated(fragment);
      if (!expected.includes(id)) continue;
      if (!(update.textContent ?? "").trim()) {
        doc.getElementById(id)?.remove();
        continue;
      }
      const replacement = fragment.getElementById(id);
      const old = doc.getElementById(id);
      if (!old || !replacement) throw new UnipaError("FORMAT_CHANGED");
      old.replaceWith(replacement);
      changed = true;
    }
  }
  if (!changed || !viewState) throw new UnipaError("FORMAT_CHANGED");
  // Apply state after all HTML replacements, regardless of XML update order.
  for (const target of doc.querySelectorAll("form")) {
    const inputs = target.querySelectorAll(
      'input[name="javax.faces.ViewState"]',
    );
    if (!inputs.length) {
      const input = doc.createElement("input");
      input.setAttribute("type", "hidden");
      input.setAttribute("name", "javax.faces.ViewState");
      target.appendChild(input);
      inputs.push(input);
    }
    for (const input of inputs) input.setAttribute("value", viewState);
  }
  assertAuthenticated(doc);
  return doc;
}
