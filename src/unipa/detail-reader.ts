import {
  ajaxConfig,
  ajaxFields,
  applyPartial,
  assertAuthenticated,
  form,
  html,
  text,
  type HtmlDocument,
} from "./jsf";
import { collectNoticeBoard, parseNotices } from "./notices";
import { parseNoticeBody, type NoticeBodyReader } from "./body";
import { UnipaError } from "./types";

function labelledValue(doc: HtmlDocument, label: string): string {
  const rows = Array.from(doc.querySelectorAll("tr")).filter(
    (row) =>
      text(
        row.querySelector("td:first-child label") ??
          row.querySelector("td:first-child") ?? { textContent: "" },
      ) === label,
  );
  if (rows.length !== 1) throw new UnipaError("FORMAT_CHANGED");
  const value = rows[0]!.querySelector("td:nth-child(2)");
  if (!value) throw new UnipaError("FORMAT_CHANGED");
  return text(value);
}

// A single-use detail reader, built from the same freshly verified complete board.
// It supports parsed PrimeFaces metadata only; unknown live commands fail closed.
// It is not registered as a read-only MCP tool and may change upstream read state.
export function createNoticeBoardBodyReader(
  board: Awaited<ReturnType<typeof collectNoticeBoard>>,
): NoticeBodyReader {
  let used = false;
  return {
    readEffect: "may_mark_read",
    async read(notice, signal) {
      if (used || signal?.aborted) throw new UnipaError("FORMAT_CHANGED");
      const panel = board.doc.getElementById(board.panelId);
      if (!panel) throw new UnipaError("FORMAT_CHANGED");
      const notices = await parseNotices(panel);
      const index = notices.findIndex(
        (item) =>
          item.id === notice.id &&
          JSON.stringify(item) === JSON.stringify(notice),
      );
      if (index < 0 || notices[index]!.unread !== true)
        throw new UnipaError("FORMAT_CHANGED");
      const anchor = panel
        .querySelectorAll("dl.keiji")
        [index]?.querySelector("a.ui-commandlink");
      const source = anchor?.getAttribute("id");
      const command = anchor?.getAttribute("onclick") ?? "";
      if (!source?.startsWith("funcForm:"))
        throw new UnipaError("FORMAT_CHANGED");
      let detail: HtmlDocument;
      if (command.includes("PrimeFaces.ab(")) {
        const config = ajaxConfig(command, source);
        if (
          (config.f && config.f !== "funcForm") ||
          (config.p && config.p !== source && config.p !== "@this") ||
          (config.e && config.e !== "click")
        )
          throw new UnipaError("FORMAT_CHANGED");
        const targets = (config.u ?? "").split(/\s+/).filter(Boolean);
        if (
          !targets.length ||
          targets.some(
            (target) =>
              !(target === "funcForm" || target.startsWith("funcForm:")) ||
              !board.doc.getElementById(target),
          )
        )
          throw new UnipaError("FORMAT_CHANGED");
        const action = ajaxFields(board.doc, board.pageUrl, source, config);
        action.fields.set(source, source);
        used = true; // A failed request may already have marked the notice read.
        detail = applyPartial(
          board.doc,
          await board.session.request(action.action, action.fields, true),
          targets,
        );
      } else {
        const transition = command.match(
          /syncTransition\(['"]([^'"]+)['"]\)/,
        )?.[1];
        const submit = command.match(
          /PrimeFaces\.addSubmitParam\(['"]funcForm['"],\s*\{([^{}]+)\}\)\.submit\(['"]funcForm['"]\)/,
        )?.[1];
        const entries = [
          ...(submit ?? "").matchAll(
            /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g,
          ),
        ];
        if (
          transition !== source ||
          entries.length !== 1 ||
          entries[0]![1] !== source ||
          entries[0]![2] !== source
        )
          throw new UnipaError("FORMAT_CHANGED");
        const action = form(board.doc, "funcForm", board.pageUrl);
        action.fields.set(source, source);
        action.fields.set("rx.sync.source", source);
        used = true;
        detail = html(
          (await board.session.request(action.action, action.fields)).body,
        );
        assertAuthenticated(detail);
      }
      // Prevent returning a different detail page under a previously selected identity.
      if (
        labelledValue(detail, "件名") !== notice.title ||
        labelledValue(detail, "カテゴリ") !== notice.category ||
        labelledValue(detail, "差出人") !== notice.sender
      )
        throw new UnipaError("FORMAT_CHANGED");
      try {
        return parseNoticeBody(
          (detail as unknown as { toString(): string }).toString(),
          notice.id,
        );
      } catch {
        throw new UnipaError("FORMAT_CHANGED");
      }
    },
  };
}
