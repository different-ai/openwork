import { describe, expect, test } from "bun:test";
import {
  nextScheduledTaskOccurrence,
  previewScheduledTaskSchedule,
} from "./scheduled-task-schedule.js";

describe("scheduled task schedule", () => {
  test("previews the next five daily occurrences in the selected timezone", () => {
    const generatedAt = Date.UTC(2026, 0, 1, 12, 0);
    const preview = previewScheduledTaskSchedule({
      kind: "daily",
      timezone: "Europe/Berlin",
      hour: 9,
      minute: 30,
    }, { generatedAt, after: generatedAt });

    expect(preview.occurrences).toHaveLength(5);
    expect(new Date(preview.occurrences[0]!).toISOString()).toBe("2026-01-02T08:30:00.000Z");
  });

  test("shifts a missing spring-forward wall time and reports it", () => {
    const after = Date.UTC(2026, 2, 7, 12, 0);
    const preview = previewScheduledTaskSchedule({
      kind: "daily",
      timezone: "America/New_York",
      hour: 2,
      minute: 30,
    }, { generatedAt: after, after });

    expect(new Date(preview.occurrences[0]!).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(preview.warnings).toHaveLength(1);
  });

  test("chooses the first instant for a repeated fall-back wall time", () => {
    const after = Date.UTC(2026, 9, 31, 12, 0);
    const next = nextScheduledTaskOccurrence({
      kind: "daily",
      timezone: "America/New_York",
      hour: 1,
      minute: 30,
    }, after);

    expect(new Date(next!).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  test("honors weekly day selection and manual schedules", () => {
    const after = Date.UTC(2026, 6, 27, 12, 0);
    const weekly = nextScheduledTaskOccurrence({
      kind: "weekly",
      timezone: "UTC",
      daysOfWeek: [2],
      hour: 8,
      minute: 15,
    }, after);

    expect(new Date(weekly!).toISOString()).toBe("2026-07-28T08:15:00.000Z");
    expect(nextScheduledTaskOccurrence({
      kind: "manual",
      timezone: "UTC",
    }, after)).toBeNull();
  });
});
