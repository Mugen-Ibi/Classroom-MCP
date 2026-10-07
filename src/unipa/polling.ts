import { UnipaError } from "./types";

export const UNIPA_POLL_CRON = "0 3,8,22 * * *";
export const UNIPA_TIMEZONE = "Asia/Tokyo";
export const SLOT_GRACE_MS = 10 * 60_000;
const dayMs = 24 * 3600_000;
const jstOffset = 9 * 3600_000;
function validTime(time: number) {
  if (!Number.isFinite(time) || time < 0) throw new Error("INVALID_POLL_STATE");
}
export function unipaMaintenance(now = Date.now()): boolean {
  validTime(now);
  const hour = new Date(now + jstOffset).getUTCHours();
  return hour >= 2 && hour < 5;
}
export function currentNoticeSlot(now = Date.now()): number | null {
  validTime(now);
  const jst = now + jstOffset,
    day = Math.floor(jst / dayMs) * dayMs;
  for (const hour of [7, 12, 17]) {
    const slot = day + hour * 3600_000 - jstOffset;
    if (now >= slot && now - slot < SLOT_GRACE_MS) return slot;
  }
  return null;
}
export function nextNoticeSlot(now = Date.now()): number {
  validTime(now);
  const day = Math.floor((now + jstOffset) / dayMs) * dayMs;
  for (const offset of [0, dayMs])
    for (const hour of [7, 12, 17]) {
      const slot = day + offset + hour * 3600_000 - jstOffset;
      if (slot > now) return slot;
    }
  throw new Error("INVALID_POLL_STATE");
}
export function assertUnipaRequestAllowed(now = Date.now()): void {
  if (unipaMaintenance(now)) throw new UnipaError("MAINTENANCE_WINDOW");
  if (currentNoticeSlot(now) === null)
    throw new UnipaError("OUTSIDE_FETCH_WINDOW");
}
// One persisted attempt per JST slot, including failures. No catch-up outside the
// ten-minute Cron delivery window and no retry in the same slot.
export function noticePollDue(
  input: { enabled?: boolean },
  lastAttemptAt: number | null,
  retryAt: number | null | undefined,
  now = Date.now(),
  scheduledAt?: number,
): boolean {
  validTime(now);
  if (lastAttemptAt !== null) {
    validTime(lastAttemptAt);
    if (lastAttemptAt > now) throw new Error("INVALID_POLL_STATE");
  }
  if (retryAt !== null && retryAt !== undefined) validTime(retryAt);
  const slot = currentNoticeSlot(now);
  if (
    !input.enabled ||
    unipaMaintenance(now) ||
    slot === null ||
    retryAt === null ||
    (retryAt !== undefined && retryAt > now)
  )
    return false;
  if (scheduledAt !== undefined) {
    validTime(scheduledAt);
    if (scheduledAt !== slot) return false;
  }
  return lastAttemptAt === null || lastAttemptAt < slot;
}
export function snapshotFreshUntil(fetchedAt: string): number {
  return nextNoticeSlot(Date.parse(fetchedAt));
}
