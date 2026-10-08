import { describe, expect, test } from "bun:test";
import { automationNameFrom, nextOpenSlot, slotAt, slotLabel, slotScheduleOptions } from "./slot";

const ZONE = "America/Los_Angeles";

describe("creating an Automation from a calendar slot", () => {
  test("a click snaps to :00 or :30 in the display zone", () => {
    const tuesday = { year: 2026, month: 10, day: 13 };
    expect(slotAt(tuesday, 11 * 60 + 12, ZONE)).toMatchObject({ hour: 11, minute: 0, at: Date.parse("2026-10-13T18:00:00Z") });
    expect(slotAt(tuesday, 11 * 60 + 44, ZONE)).toMatchObject({ hour: 11, minute: 30, at: Date.parse("2026-10-13T18:30:00Z") });
    expect(slotLabel(slotAt(tuesday, 11 * 60, ZONE))).toBe("Tue, Oct 13 at 11:00 AM");
  });

  test("the four repeats keep the slot's time and zone", () => {
    const options = slotScheduleOptions(slotAt({ year: 2026, month: 10, day: 13 }, 11 * 60, ZONE));
    expect(options.map((option) => option.label)).toEqual(["Once", "Tuesdays", "Weekdays", "Every day"]);
    expect(options[0]?.schedule).toEqual({ kind: "once", timezone: ZONE, at: Date.parse("2026-10-13T18:00:00Z") });
    expect(options[1]?.schedule).toEqual({ kind: "weekly", timezone: ZONE, daysOfWeek: [2], hour: 11, minute: 0 });
    expect(options[2]?.schedule).toEqual({ kind: "weekly", timezone: ZONE, daysOfWeek: [1, 2, 3, 4, 5], hour: 11, minute: 0 });
    expect(options[3]?.schedule).toEqual({ kind: "daily", timezone: ZONE, hour: 11, minute: 0 });
  });

  test("a slot on the skipped hour of a DST change still resolves to a real instant", () => {
    const slot = slotAt({ year: 2027, month: 3, day: 14 }, 2 * 60 + 30, ZONE);
    expect(new Date(slot.at).toISOString()).toBe("2027-03-14T10:30:00.000Z");
  });

  test("the toolbar slot is the next full hour, or 9 AM tomorrow in the evening", () => {
    expect(nextOpenSlot(Date.parse("2026-10-13T17:20:00Z"), ZONE)).toMatchObject({ hour: 11, minute: 0, date: { day: 13 } });
    expect(nextOpenSlot(Date.parse("2026-10-14T02:00:00Z"), ZONE)).toMatchObject({ hour: 9, minute: 0, date: { day: 14 } });
  });

  test("names come from the first sentence, capped on a word", () => {
    expect(automationNameFrom("pull this week's press kit comments. Then draft replies.")).toBe("Pull this week's press kit comments");
    expect(automationNameFrom("   ")).toBe("New automation");
    const long = automationNameFrom("Summarize every open Linear issue assigned to the launch team with owners and due dates and blockers");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("naming from free text", () => {
  test("long runs of punctuation stay fast", () => {
    const started = performance.now();
    expect(automationNameFrom(`Ship it ${"! ".repeat(50_000)}`)).toBe("Ship it");
    expect(automationNameFrom(`Ship it${"!".repeat(50_000)}`)).toBe("Ship it");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
