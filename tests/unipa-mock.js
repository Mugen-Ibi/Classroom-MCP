import {
  loginHtml,
  portalHtml,
  boardHtml,
  partial,
  rows,
  tabId,
  panelId,
  allId,
  moreId,
} from "./unipa-fixtures.js";

// All requests are served locally. Unexpected (including write/detail/API) calls fail.
export const unipaRequestTrace = [];
export async function mockUnipa(request) {
  const path = new URL(request.url).pathname;
  unipaRequestTrace.push({ path, method: request.method });
  const fields = new URLSearchParams(
    request.method === "POST" ? await request.text() : "",
  );
  const cookie = request.headers.get("Cookie") ?? "";
  const reply = (body, login = false) =>
    new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": `${login ? "JSESSIONID=synthetic-auth" : "JSESSIONID=synthetic-anonymous"}; Path=/uprx; Secure; HttpOnly`,
      },
    });
  if (path === "/uprx/" && request.method === "GET") return reply(loginHtml);
  if (
    path === "/uprx/up/pk/pky001/Pky00101.xhtml" &&
    fields.get("loginForm:loginButton") === "loginForm:loginButton" &&
    fields.get("loginForm:userId") === "synthetic-student-id" &&
    fields.get("loginForm:password") === "synthetic-password" &&
    fields.get("javax.faces.ViewState") === "synthetic-login-state" &&
    cookie.includes("synthetic-anonymous")
  )
    return reply(portalHtml, true);
  if (!cookie.includes("JSESSIONID=synthetic-auth")) return reply(loginHtml);
  if (
    path === "/uprx/up/bs/bsa001/Bsa00101.xhtml" &&
    fields.get("rx.sync.source") === "menuForm:dynamicMenu" &&
    fields.get("menuForm:dynamicMenu_menuid") === "9_7_5" &&
    fields.get("rx-token") === "synthetic-rx-state"
  )
    return reply(boardHtml(), true);
  if (
    path === "/uprx/up/bs/bsd007/Bsd00701.xhtml" &&
    request.headers.get("Faces-Request") === "partial/ajax"
  ) {
    if (
      fields.get("javax.faces.source") === tabId &&
      fields.get(`${tabId}_newTab`) === panelId &&
      fields.get("javax.faces.ViewState") === "synthetic-board-state"
    ) {
      const form = boardHtml(15, 38, true).match(
        /<form[^>]*>[\s\S]*?<\/form>/,
      )[0];
      return reply(partial([["funcForm", form]], "synthetic-tab-state"), true);
    }
    if (
      fields.get("javax.faces.source") === moreId &&
      fields.get(moreId) === moreId &&
      fields.get("javax.faces.ViewState") === "synthetic-tab-state"
    )
      return reply(
        partial([
          [allId, `<div id="${allId}">${rows(38)}</div>`],
          [moreId, ""],
        ]),
        true,
      );
  }
  return new Response("Unexpected test request", { status: 500 });
}
