import { z } from "zod";
import type { Notice } from "./types";

export const importancePolicySchema = z.object({
  additionalCriticalTerms: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .default([]),
  excludedTerms: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});
export type ImportancePolicy = z.input<typeof importancePolicySchema>;
export type ImportanceReason =
  | "schedule"
  | "deadline_action"
  | "payment"
  | "security"
  | "personal_action"
  | "custom";
export interface ImportanceDecision {
  level: "critical_candidate" | "routine_candidate" | "unknown";
  reasons: ImportanceReason[];
  evidence: "metadata_only";
  requiresReview: boolean;
}

// These are adjustable candidate rules, not a determination of the notice's meaning.
export function classifyImportance(
  notice: Notice,
  input: ImportancePolicy = {},
): ImportanceDecision {
  const policy = importancePolicySchema.parse(input);
  const title = notice.title.normalize("NFKC");
  const metadata = [title, notice.category.normalize("NFKC")].join(" ");
  const reasons: ImportanceReason[] = [];
  if (
    /休講|(?:教室|時限|授業時間|授業日時|時間割).{0,12}変更|変更.{0,12}(?:教室|時限|授業時間)/u.test(
      metadata,
    )
  )
    reasons.push("schedule");
  if (
    /締切|期限|期日|までに/u.test(metadata) &&
    /提出|申請|手続|登録|回答|要対応/u.test(metadata)
  )
    reasons.push("deadline_action");
  if (
    /学費|授業料|納付|支払|支払い|未納/u.test(title) &&
    /期限|期日|請求|納付|支払|支払い|未納/u.test(title)
  )
    reasons.push("payment");
  if (
    /アカウント|パスワード|セキュリティ|不正アクセス|認証/u.test(title) &&
    /停止|失効|侵害|不正|要対応|変更.{0,8}(?:必要|依頼|お願い)|期限/u.test(
      title,
    )
  )
    reasons.push("security");
  if (
    /本人|あなた|個別|個人宛/u.test(title) &&
    /要対応|要確認|提出|手続|回答|至急/u.test(title)
  )
    reasons.push("personal_action");
  if (
    policy.additionalCriticalTerms.some((term) =>
      metadata.includes(term.normalize("NFKC")),
    )
  )
    reasons.push("custom");
  if (reasons.length)
    return {
      level: "critical_candidate",
      reasons,
      evidence: "metadata_only",
      requiresReview: true,
    };
  // A general event exclusion never overrides a stronger action/urgency signal.
  const uncertain =
    notice.important ||
    /重要|緊急|至急|要対応|提出|期限|手続|変更/u.test(metadata);
  const routine =
    policy.excludedTerms.some((term) =>
      metadata.includes(term.normalize("NFKC")),
    ) ||
    /広報|イベント|交流会|セミナー|講演会|オープンキャンパス/u.test(metadata);
  return {
    level: !uncertain && routine ? "routine_candidate" : "unknown",
    reasons,
    evidence: "metadata_only",
    requiresReview: uncertain || !routine,
  };
}
