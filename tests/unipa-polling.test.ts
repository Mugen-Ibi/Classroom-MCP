import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentNoticeSlot,
  nextNoticeSlot,
  noticePollDue,
  unipaMaintenance,
  assertUnipaRequestAllowed,
  UNIPA_POLL_CRON,
  SLOT_GRACE_MS,
} from "../src/unipa/polling";
import { UnipaSession } from "../src/unipa/session";
const time = (value: string) => Date.parse(value);
afterEach(() => vi.restoreAllMocks());
describe("three daily JST acquisition slots", () => {
  it.each([
    ["2026-10-06T22:00:00Z", "07:00"],
    ["2026-10-07T03:00:00Z", "12:00"],
    ["2026-10-07T08:00:00Z", "17:00"],
  ])("maps %s to Japan time %s", (utc) => {
    const now = time(utc);
    expect(UNIPA_POLL_CRON).toBe("0 3,8,22 * * *");
    expect(currentNoticeSlot(now)).toBe(now);
    expect(noticePollDue({ enabled: true }, null, undefined, now, now)).toBe(
      true,
    );
  });
  it("allows bounded Cron delay but rejects duplicates, early/late/stale executions and future state", () => {
    const slot = time("2026-10-06T22:00:00Z");
    expect(
      noticePollDue({ enabled: true }, null, undefined, slot - 1, slot),
    ).toBe(false);
    expect(
      noticePollDue(
        { enabled: true },
        null,
        undefined,
        slot + SLOT_GRACE_MS - 1,
        slot,
      ),
    ).toBe(true);
    expect(
      noticePollDue({ enabled: true }, slot + 1, undefined, slot + 3000, slot),
    ).toBe(false);
    expect(
      noticePollDue(
        { enabled: true },
        null,
        undefined,
        slot + SLOT_GRACE_MS,
        slot,
      ),
    ).toBe(false);
    expect(
      noticePollDue({ enabled: true }, null, undefined, slot + 86400_000, slot),
    ).toBe(false);
    expect(() =>
      noticePollDue({ enabled: true }, slot + 1, undefined, slot),
    ).toThrow("INVALID_POLL_STATE");
  });
  it("does not fetch on demand between slots or reset same-slot attempts after backoff", () => {
    const slot = time("2026-10-07T03:00:00Z");
    expect(noticePollDue({}, null, undefined, slot)).toBe(false);
    expect(noticePollDue({ enabled: true }, null, null, slot)).toBe(false);
    expect(noticePollDue({ enabled: true }, null, slot + 1000, slot)).toBe(
      false,
    );
    expect(
      noticePollDue({ enabled: true }, slot, slot + 1000, slot + 2000),
    ).toBe(false);
    expect(
      noticePollDue(
        { enabled: true },
        slot,
        undefined,
        time("2026-10-07T09:07:00Z"),
      ),
    ).toBe(false);
    expect(
      noticePollDue(
        { enabled: true },
        slot,
        undefined,
        time("2026-10-07T08:00:00Z"),
      ),
    ).toBe(true);
  });
  it("computes next acquisition across the JST/UTC date boundary", () => {
    expect(nextNoticeSlot(time("2026-10-07T08:00:00Z"))).toBe(
      time("2026-10-07T22:00:00Z"),
    );
    expect(nextNoticeSlot(time("2026-10-07T22:00:00Z"))).toBe(
      time("2026-10-08T03:00:00Z"),
    );
  });
  it.each([
    ["2026-10-07T16:59:59.999Z", false],
    ["2026-10-07T17:00:00Z", true],
    ["2026-10-07T19:59:59.999Z", true],
    ["2026-10-07T20:00:00Z", false],
  ])("maintenance boundary %s -> %s", (utc, blocked) => {
    expect(unipaMaintenance(time(utc as string))).toBe(blocked);
    expect(
      noticePollDue({ enabled: true }, null, undefined, time(utc as string)),
    ).toBe(false);
  });
  it.each([
    "2026-10-07T17:00:00Z",
    "2026-10-07T19:59:59.999Z",
    "2026-10-07T09:07:00Z",
  ])(
    "blocks direct/detail/manual requests before transport at %s",
    async (utc) => {
      vi.spyOn(Date, "now").mockReturnValue(time(utc));
      const transport = vi.fn();
      await expect(
        new UnipaSession(undefined, transport).request("/uprx/"),
      ).rejects.toMatchObject({
        code: unipaMaintenance()
          ? "MAINTENANCE_WINDOW"
          : "OUTSIDE_FETCH_WINDOW",
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it("does not follow a redirect after the acquisition window closes", async () => {
    let now = time("2026-10-07T03:09:59Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const transport = vi.fn(async () => {
      now = time("2026-10-07T03:10:00Z");
      return new Response(null, {
        status: 302,
        headers: { Location: "/uprx/" },
      });
    });
    await expect(
      new UnipaSession(undefined, transport).request("/uprx/"),
    ).rejects.toMatchObject({ code: "OUTSIDE_FETCH_WINDOW" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("cannot bypass the policy with invalid timestamps", () => {
    for (const value of [NaN, Infinity, -1])
      expect(() => assertUnipaRequestAllowed(value)).toThrow(
        "INVALID_POLL_STATE",
      );
  });
});
