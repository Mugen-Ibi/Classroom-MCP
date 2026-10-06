// Synthetic HTML only. No university notice, credential, Cookie, or ViewState is copied.
export const loginHtml = `<html><body><form id="loginForm" action="/uprx/up/pk/pky001/Pky00101.xhtml"><input type="hidden" name="loginForm" value="loginForm"><input type="hidden" name="javax.faces.ViewState" value="synthetic-login-state"><input type="text" name="loginForm:userId"><input type="password" name="loginForm:password"><button name="loginForm:loginButton">LOGIN</button></form></body></html>`;
export const portalHtml = `<html><body><form id="menuForm" action="/uprx/up/bs/bsa001/Bsa00101.xhtml"><input type="hidden" name="javax.faces.ViewState" value="synthetic-menu-state"><input type="hidden" name="rx-token" value="synthetic-rx-state"><a data-pfconfirmcommand="syncTransition('menuForm:dynamicMenu');PrimeFaces.addSubmitParam('menuForm',{'menuForm:dynamicMenu':'menuForm:dynamicMenu','menuForm:dynamicMenu_menuid':'9_7_5'}).submit('menuForm');return false;">掲示板</a></form></body></html>`;
export const tabId = "funcForm:dynamicTabs";
export const panelId = `${tabId}:1:dynamicPanel`;
export const allId = `${tabId}:1:allScr`;
export const moreId = `${tabId}:1:dynamicMore`;
export function rows(count) {
  return Array.from(
    { length: count },
    (_, i) =>
      `<div class="alignRight"><dl id="keiji" class="keiji"><i class="${i === 0 ? "fa-exclamation-circle" : ""}"></i><span class="keijiCategory">合成カテゴリ</span><a class="ui-commandlink" onclick="FORBIDDEN_DETAIL">${i === 0 ? "休講のお知らせ" : i === 1 ? "教室変更のお知らせ" : "合成お知らせ"}</a> [合成差出人] 2026/10/06</dl><span><div><span>${i % 2 === 0 ? "既読にする" : "未読にする"}</span></div><button onclick="FORBIDDEN_READ">操作</button></span><hr></div>`,
  ).join("");
}
export function boardHtml(
  count = 15,
  total = 38,
  selected = false,
  more = true,
) {
  return `<html><body><h1>掲示板[Bsd007]</h1><form id="funcForm" action="/uprx/up/bs/bsd007/Bsd00701.xhtml"><input type="hidden" name="funcForm" value="funcForm"><input type="hidden" name="javax.faces.ViewState" value="synthetic-board-state"><input type="hidden" name="rx-loginKey" value="synthetic-rx-key"><div id="${tabId}"><ul><li role="tab"><a href="#${tabId}:0:group">グループ</a></li><li role="tab"><a href="#${panelId}">全表示</a></li></ul><input type="hidden" name="${tabId}_activeIndex" value="${selected ? 1 : 0}"><div id="${panelId}"><div id="${allId}">${rows(count)}</div><span>全${total}件</span>${more ? `<button id="${moreId}" onclick='PrimeFaces.ab({s:"${moreId}",f:"funcForm",p:"${moreId}",u:"${allId} ${moreId}"});return false;'>すべて表示する</button>` : ""}</div></div><script>PrimeFaces.cw("TabView","widget",{behaviors:{tabChange:function(ext){PrimeFaces.ab({s:"${tabId}",e:"tabChange",f:"funcForm",p:"${tabId}",u:"funcForm"},ext);}}});</script></form></body></html>`;
}
export function partial(updates, state = "synthetic-updated-state") {
  return `<partial-response><changes>${updates.map(([id, body]) => `<update id="${id}"><![CDATA[${body}]]></update>`).join("")}<update id="javax.faces.ViewState"><![CDATA[${state}]]></update></changes></partial-response>`;
}
