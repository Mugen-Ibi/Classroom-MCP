import type { Notice } from "./types";

export function scheduleChanges(notices: Notice[]) {
  return notices.flatMap((notice) => {
    const kinds: ("cancellation" | "room_change")[] = [];
    if (/休講/.test(notice.title)) kinds.push("cancellation");
    if (/教室変更|教室の変更|教室を変更/.test(notice.title))
      kinds.push("room_change");
    return kinds.map((kind) => ({
      noticeId: notice.id,
      kind,
      title: notice.title,
      category: notice.category,
      postedDate: notice.postedDate,
      evidence: "title" as const,
      courseName: null,
      effectiveDate: null,
      period: null,
      room: null,
      requiresOfficialConfirmation: true,
      officialUrl: notice.officialUrl,
    }));
  });
}
