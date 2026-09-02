import { describe, expect, test } from "bun:test";

import {
  readOpenworkRuntimeFacts,
  renderOpenworkRuntimeContext,
} from "../src/react-app/domains/session/sync/runtime-context";

// 2026-09-02T02:38:00Z: already September 2 in UTC, still the evening of
// September 1 on the US West Coast — the exact boundary that produces
// UTC-dated files when an agent assumes the host clock is the person's.
const LATE_EVENING_PACIFIC = new Date("2026-09-02T02:38:00Z");

describe("readOpenworkRuntimeFacts", () => {
  test("reports the person's calendar date and offset for the supplied zone, not the host's", () => {
    const facts = readOpenworkRuntimeFacts({
      now: LATE_EVENING_PACIFIC,
      timeZone: "America/Los_Angeles",
      locale: "en-US",
    });

    expect(facts).toEqual({
      timeZone: "America/Los_Angeles",
      utcOffset: "UTC-07:00",
      localDate: "2026-09-01",
      weekday: "Tuesday",
      locale: "en-US",
    });
  });

  test("the same instant is the next day east of UTC", () => {
    const facts = readOpenworkRuntimeFacts({
      now: LATE_EVENING_PACIFIC,
      timeZone: "Europe/Berlin",
      locale: "de-DE",
    });

    expect(facts.localDate).toBe("2026-09-02");
    expect(facts.weekday).toBe("Wednesday");
    expect(facts.utcOffset).toBe("UTC+02:00");
  });

  test("handles half-hour offsets and standard time", () => {
    expect(readOpenworkRuntimeFacts({ now: LATE_EVENING_PACIFIC, timeZone: "Asia/Kolkata", locale: "en-IN" }).utcOffset).toBe("UTC+05:30");
    expect(readOpenworkRuntimeFacts({ now: new Date("2026-01-15T12:00:00Z"), timeZone: "America/Los_Angeles", locale: "en-US" }).utcOffset).toBe("UTC-08:00");
    expect(readOpenworkRuntimeFacts({ now: LATE_EVENING_PACIFIC, timeZone: "UTC", locale: "en-US" }).utcOffset).toBe("UTC+00:00");
  });

  test("falls back to UTC for an unknown zone instead of failing the send", () => {
    const facts = readOpenworkRuntimeFacts({ now: LATE_EVENING_PACIFIC, timeZone: "Mars/Olympus_Mons", locale: "en-US" });

    expect(facts.timeZone).toBe("UTC");
    expect(facts.localDate).toBe("2026-09-02");
  });

  test("detects the zone and locale from the runtime when none are supplied", () => {
    const facts = readOpenworkRuntimeFacts({ now: LATE_EVENING_PACIFIC });

    expect(facts.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(facts.locale.length).toBeGreaterThan(0);
    expect(facts.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("renderOpenworkRuntimeContext", () => {
  test("renders stable facts and the relative-date rule, never the wall-clock time", () => {
    const context = renderOpenworkRuntimeContext(readOpenworkRuntimeFacts({
      now: LATE_EVENING_PACIFIC,
      timeZone: "America/Los_Angeles",
      locale: "en-US",
    }));

    expect(context.split("\n")).toEqual([
      "User context:",
      "- Time zone: America/Los_Angeles (UTC-07:00)",
      "- Today's date in that time zone: Tuesday 2026-09-01",
      "- Locale: en-US",
      "Resolve \"today\", \"tomorrow\", \"this week\", and other relative dates and times in this time zone, even when another date or clock in this prompt or on the host differs. For the exact current time, read the system clock and convert it to this time zone.",
    ]);
    // Negative half: a per-turn value would invalidate the provider prompt
    // cache on every request, so the minute must not be rendered.
    expect(context).not.toContain("02:38");
    expect(context).not.toContain("19:38");
  });
});
