import { z } from "zod";
import { html, text } from "./jsf";
import { classifyImportance, type ImportancePolicy } from "./importance";
import { safeError, type Notice, type ErrorCode } from "./types";

export const bodyPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowReadStateChange: z.boolean().default(false),
  maxPerCycle: z.number().int().min(1).max(20).default(3),
  maxCharacters: z.number().int().min(100).max(32_000).default(16_000),
});
export type BodyPolicy = z.input<typeof bodyPolicySchema>;
const bodySchema = z
  .object({
    noticeId: z.string().min(1).max(100),
    text: z.string().min(1).max(32_000),
    trust: z.literal("untrusted_source"),
  })
  .strict();
export type NoticeBody = z.infer<typeof bodySchema>;
export interface NoticeBodyReader {
  // A new reader must not claim read-only behavior without verified upstream evidence.
  readEffect: "verified_read_only" | "may_mark_read" | "unknown";
  read(notice: Notice, signal?: AbortSignal): Promise<NoticeBody>;
}
export type BodyStatus =
  | "disabled"
  | "not_critical"
  | "already_read"
  | "unread_unknown"
  | "read_state_consent_required"
  | "reader_unavailable"
  | "budget_exceeded"
  | "failed"
  | "expired"
  | "retrieved";
export interface BodyResult {
  noticeId: string;
  unreadAtDetection: boolean | null;
  status: BodyStatus;
  readStateMayHaveChanged: boolean;
  body?: NoticeBody;
  failure?: { code: ErrorCode; retryAfterSeconds: number };
}

// Authorization/owner checks belong at the caller boundary before passing any notices.
// This helper has no default transport and never connects to UNIPA by itself.
export async function acquireImportantBodies(
  notices: Notice[],
  input: BodyPolicy = {},
  importance: ImportancePolicy = {},
  reader?: NoticeBodyReader,
  signal?: AbortSignal,
): Promise<BodyResult[]> {
  const policy = bodyPolicySchema.parse(input);
  const results: BodyResult[] = [];
  let attempted = 0;
  for (const notice of notices) {
    const result: BodyResult = {
      noticeId: notice.id,
      unreadAtDetection: notice.unread,
      status: "disabled",
      readStateMayHaveChanged: false,
    };
    if (!policy.enabled) result.status = "disabled";
    else if (
      classifyImportance(notice, importance).level !== "critical_candidate"
    )
      result.status = "not_critical";
    else if (notice.unread === false) result.status = "already_read";
    else if (notice.unread === null) result.status = "unread_unknown";
    else if (!reader) result.status = "reader_unavailable";
    else if (
      reader.readEffect !== "verified_read_only" &&
      !policy.allowReadStateChange
    )
      result.status = "read_state_consent_required";
    else if (attempted >= policy.maxPerCycle) result.status = "budget_exceeded";
    else if (signal?.aborted) result.status = "failed";
    else {
      attempted++;
      result.readStateMayHaveChanged =
        reader.readEffect !== "verified_read_only";
      try {
        const body = bodySchema.parse(await reader.read(notice, signal));
        if (
          body.noticeId !== notice.id ||
          body.text.length > policy.maxCharacters
        )
          throw new Error("Invalid body");
        result.status = "retrieved";
        result.body = body;
      } catch (error) {
        // Upstream exceptions/response bodies may contain credentials. Never return them.
        result.status = "failed";
        const failure = safeError(error);
        result.failure = {
          code: failure.code,
          retryAfterSeconds: failure.retryAfterSeconds,
        };
      }
    }
    results.push(result);
  }
  return results;
}

// Parses an already supplied, sanitized detail fixture. It does not open a detail link.
// The labelled table structure is recorded in the existing UNIPA investigation.
export function parseNoticeBody(
  markup: string,
  noticeId: string,
  maxCharacters = 16_000,
): NoticeBody {
  bodyPolicySchema.parse({ maxCharacters });
  if (new TextEncoder().encode(markup).length > 256 * 1024)
    throw new Error("BODY_FORMAT_INVALID");
  const doc = html(markup);
  const matches = Array.from(doc.querySelectorAll("tr")).filter((row) => {
    const label =
      row.querySelector("td:first-child label") ??
      row.querySelector("td:first-child");
    return label && text(label) === "本文";
  });
  if (matches.length !== 1) throw new Error("BODY_FORMAT_INVALID");
  const value = matches[0]!.querySelector("td:nth-child(2)");
  if (!value) throw new Error("BODY_FORMAT_INVALID");
  for (const element of value.querySelectorAll(
    "script,style,form,input,button,iframe,object,embed",
  ))
    element.remove();
  for (const br of value.querySelectorAll("br")) {
    const replacement = doc.createElement("span");
    replacement.textContent = "\n";
    br.replaceWith(replacement);
  }
  const bodyText = text(value);
  if (bodyText.length > maxCharacters) throw new Error("BODY_TOO_LARGE");
  return bodySchema.parse({
    noticeId,
    text: bodyText,
    trust: "untrusted_source",
  });
}
