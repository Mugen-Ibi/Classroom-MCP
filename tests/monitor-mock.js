import google from "./google-mock.js";
import { loginHtml, portalHtml, boardHtml, partial } from "./unipa-fixtures.js";
let changed = false;
let callbackStatus = 202;
const events = [],
  trace = [];
const callbacks = [];
const routes = [];
const source = "funcForm:dynamicFixture:detail";
const keyBytes = new TextEncoder().encode("fixture-only-public-key-material!");
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__"))
      routes.push({ host: url.hostname, path: url.pathname });
    if (url.pathname === "/__next_fixture") {
      changed = true;
      return new Response("fixture changed");
    }
    if (url.pathname === "/__fail_callback_fixture") {
      callbackStatus = 500;
      return new Response("fixture failure enabled");
    }
    if (url.pathname === "/__accept_callback_fixture") {
      callbackStatus = 202;
      return new Response("fixture acceptance enabled");
    }
    if (url.pathname === "/__trace_fixture")
      return Response.json({ events, trace, callbacks, routes });
    if (url.hostname === "receiver.example.com") {
      callbacks.push({
        received: true,
        hasSignature: request.headers.has("webhook-signature"),
      });
      const text = await request.text(),
        data = JSON.parse(text);
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const signature = (request.headers.get("webhook-signature") ?? "").split(
        ",",
      )[1];
      if (
        !signature ||
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
          new TextEncoder().encode(
            `${request.headers.get("webhook-id")}.${request.headers.get("webhook-timestamp")}.${text}`,
          ),
        ))
      ) {
        callbacks.at(-1).reason = "signature_invalid";
        return new Response("invalid fixture signature", { status: 401 });
      }
      if (data.type === "verification")
        return Response.json({ challenge: data.challenge });
      events.push(data);
      return new Response(null, { status: callbackStatus });
    }
    if (url.hostname !== "unipa.i-u.ac.jp") return google.fetch(request);
    trace.push({ path: url.pathname, method: request.method });
    if (request.method === "GET" && url.pathname === "/uprx/")
      return new Response(loginHtml);
    const fields = new URLSearchParams(await request.text());
    if (url.pathname.endsWith("Pky00101.xhtml")) {
      if (
        fields.get("loginForm:userId") !== "synthetic-student-id" ||
        fields.get("loginForm:password") !== "synthetic-password"
      )
        return new Response("fixture auth rejected", { status: 401 });
      return new Response(portalHtml);
    }
    const title = changed ? "明日の休講・教室変更" : "休講のお知らせ";
    if (url.pathname.endsWith("Bsa00101.xhtml")) {
      return new Response(
        boardHtml(2, 2, true, false).replace(
          '<a class="ui-commandlink" onclick="FORBIDDEN_DETAIL">休講のお知らせ</a>',
          `<a id="${source}" class="ui-commandlink" onclick='PrimeFaces.ab({s:"${source}",f:"funcForm",p:"${source}",u:"funcForm"});return false;'>${title}</a>`,
        ),
      );
    }
    if (
      url.pathname.endsWith("Bsd00701.xhtml") &&
      fields.get("javax.faces.source") === source
    ) {
      const detail = `<form id="funcForm" action="/uprx/up/bs/bsd007/Bsd00701.xhtml"><input type="hidden" name="javax.faces.ViewState" value="fixture-detail"><table><tr><td>件名</td><td>${title}</td></tr><tr><td>カテゴリ</td><td>合成カテゴリ</td></tr><tr><td>差出人</td><td>合成差出人</td></tr><tr><td>本文</td><td>合成された重要通知の本文です。</td></tr></table></form>`;
      return new Response(partial([["funcForm", detail]]));
    }
    return new Response("unexpected fixture request", { status: 500 });
  },
};
