import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ScheduleError,
  checkScheduleGuardrails,
  isSharedSchedule,
  localDateTime,
  localOccurrences,
  nextLocalOccurrence,
  parseCronExpression,
  parseLocalSchedule,
  resolveWallTime,
} from "./local-schedule.ts";

const NEW_YORK = "America/New_York";
const guardrails = { minimumGapMinutes: 60, maxRunsPerDay: 4 };

/** The wall-clock reading of an instant in a zone, for readable assertions: "2026-03-08 03:00". */
function wall(timestamp: number, timezone: string): string {
  const local = localDateTime(timestamp, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}`;
}

test("shared schedules pass through the shared contract, with the coworker's zone filled in when missing", () => {
  const daily = parseLocalSchedule({ kind: "daily", hour: 9, minute: 0 }, { defaultTimezone: "Europe/Paris" });
  assert.deepEqual(daily, { kind: "daily", timezone: "Europe/Paris", hour: 9, minute: 0 });
  assert.equal(isSharedSchedule(daily), true);
  const weekly = parseLocalSchedule({ kind: "weekly", hour: 9, minute: 0, daysOfWeek: [5, 1, 1], timezone: "UTC" });
  assert.deepEqual(weekly, { kind: "weekly", timezone: "UTC", hour: 9, minute: 0, daysOfWeek: [1, 5] });
  assert.throws(() => parseLocalSchedule({ kind: "daily", hour: 25, minute: 0, timezone: "UTC" }), (error: unknown) =>
    error instanceof ScheduleError && /daily schedule's hour/.test(error.message));
  assert.throws(() => parseLocalSchedule({ kind: "daily", hour: 9, minute: 0, timezone: "Mars/Olympus" }), /not a time zone I know/);
  assert.throws(() => parseLocalSchedule({}), /needs a kind/);
  assert.throws(() => parseLocalSchedule({ kind: "hourly" }), /not a schedule kind I know/);
});

test("intervals accept the offered steps, a window, days, and a daily cap, in the coworker's words", () => {
  const schedule = parseLocalSchedule({
    kind: "interval",
    everyMinutes: 120,
    from: "09:00",
    until: { hour: 18, minute: 0 },
    daysOfWeek: [1, 2, 3, 4, 5],
    timezone: "UTC",
  });
  assert.deepEqual(schedule, {
    kind: "interval",
    timezone: "UTC",
    everyMinutes: 120,
    from: { hour: 9, minute: 0 },
    until: { hour: 18, minute: 0 },
    daysOfWeek: [1, 2, 3, 4, 5],
    maxPerDay: 4,
  });
  assert.equal(isSharedSchedule(schedule), false);
  // Every day of the week is the same as no restriction.
  assert.equal("daysOfWeek" in parseLocalSchedule({ kind: "interval", everyMinutes: 60, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" }), false);
  assert.throws(() => parseLocalSchedule({ kind: "interval", everyMinutes: 45, timezone: "UTC" }), /every 1, 2, 3, 4, 6, 8, or 12 hours/);
  assert.throws(() => parseLocalSchedule({ kind: "interval", everyMinutes: 60, from: "18:00", until: "09:00", timezone: "UTC" }), /start time before its end time/);
  assert.throws(() => parseLocalSchedule({ kind: "interval", everyMinutes: 60, from: "9am", timezone: "UTC" }), /start time needs an hour/);
  assert.throws(() => parseLocalSchedule({ kind: "interval", everyMinutes: 60, daysOfWeek: [7], timezone: "UTC" }), /0 \(Sunday\) to 6 \(Saturday\)/);
  assert.throws(() => parseLocalSchedule({ kind: "interval", everyMinutes: 60, maxPerDay: 0, timezone: "UTC" }), /at least 1/);
});

test("custom timetables are read as five cron fields", () => {
  const fields = parseCronExpression("0 9-18/2 * * 1-5");
  assert.deepEqual(fields.minute.values, [0]);
  assert.deepEqual(fields.hour, { any: false, values: [9, 11, 13, 15, 17], step: 2, range: [9, 18] });
  assert.equal(fields.dayOfMonth.any, true);
  assert.deepEqual(fields.dayOfWeek.values, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCronExpression("30 6 * * 7").dayOfWeek.values, [0]);
  assert.deepEqual(parseCronExpression("*/15 * * * *").minute, { any: false, values: [0, 15, 30, 45], step: 15, range: [0, 59] });
  assert.deepEqual(parseCronExpression("0 8,20 1 * *").hour.values, [8, 20]);
  assert.throws(() => parseCronExpression("0 9 * *"), /five fields/);
  assert.throws(() => parseCronExpression("0 24 * * *"), /can't read "24" as the hour/);
  assert.throws(() => parseCronExpression("a b c d e"), /can't read "a" as the minute/);
  const cron = parseLocalSchedule({ kind: "cron", expression: "  0  9 * * 1-5 ", timezone: "UTC", maxPerDay: 2 });
  assert.deepEqual(cron, { kind: "cron", timezone: "UTC", expression: "0 9 * * 1-5", maxPerDay: 2 });
});

test("wall-clock times resolve across daylight-saving changes: gaps shift forward, repeats take the first", () => {
  // Spring forward in New York on 2026-03-08: 02:00–02:59 never happens.
  const gap = resolveWallTime({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }, NEW_YORK);
  assert.equal(gap.shifted, true);
  assert.equal(wall(gap.timestamp, NEW_YORK), "2026-03-08 03:00");
  const ordinary = resolveWallTime({ year: 2026, month: 3, day: 8 }, { hour: 9, minute: 0 }, NEW_YORK);
  assert.equal(ordinary.shifted, false);
  assert.equal(ordinary.timestamp, Date.UTC(2026, 2, 8, 13, 0));
  // Fall back on 2026-11-01: 01:30 happens twice; the first (daylight time) wins.
  const repeat = resolveWallTime({ year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }, NEW_YORK);
  assert.equal(repeat.shifted, false);
  assert.equal(repeat.timestamp, Date.UTC(2026, 10, 1, 5, 30));
});

test("an interval keeps its window, its days, and its daily cap", () => {
  const schedule = parseLocalSchedule({
    kind: "interval",
    everyMinutes: 120,
    from: "09:00",
    until: "18:00",
    daysOfWeek: [1, 2, 3, 4, 5],
    timezone: "UTC",
  });
  // A Friday morning: the window offers 9, 11, 13, 15, 17 but the cap keeps four; then Monday.
  const friday = Date.UTC(2026, 8, 4, 8, 0);
  const occurrences = localOccurrences(schedule, { after: friday, count: 6 });
  assert.deepEqual(occurrences.map((occurrence) => wall(occurrence, "UTC")), [
    "2026-09-04 09:00",
    "2026-09-04 11:00",
    "2026-09-04 13:00",
    "2026-09-04 15:00",
    "2026-09-07 09:00",
    "2026-09-07 11:00",
  ]);
  // Mid-window the next slot is the next one after now, not the first of the day.
  assert.equal(wall(nextLocalOccurrence(schedule, Date.UTC(2026, 8, 4, 12, 0)) ?? 0, "UTC"), "2026-09-04 13:00");
  // No window: the day starts at midnight and the cap decides where it ends.
  const open = parseLocalSchedule({ kind: "interval", everyMinutes: 360, maxPerDay: 3, timezone: "UTC" });
  assert.deepEqual(localOccurrences(open, { after: Date.UTC(2026, 8, 4, 0, 0), count: 4 }).map((value) => wall(value, "UTC")), [
    "2026-09-04 06:00",
    "2026-09-04 12:00",
    "2026-09-05 00:00",
    "2026-09-05 06:00",
  ]);
});

test("an interval crossing a daylight-saving gap never repeats an instant and never runs closer than its step in real time", () => {
  const schedule = parseLocalSchedule({ kind: "interval", everyMinutes: 60, from: "00:00", until: "04:00", maxPerDay: 5, timezone: NEW_YORK });
  const before = Date.UTC(2026, 2, 8, 4, 30); // 23:30 on March 7, New York
  const occurrences = localOccurrences(schedule, { after: before, count: 5 });
  assert.deepEqual(occurrences.map((occurrence) => wall(occurrence, NEW_YORK)), [
    "2026-03-08 00:00",
    "2026-03-08 01:00",
    "2026-03-08 03:00",
    "2026-03-08 04:00",
    "2026-03-09 00:00",
  ]);
  for (let index = 1; index < 4; index += 1) {
    assert.equal((occurrences[index] ?? 0) - (occurrences[index - 1] ?? 0), 60 * 60_000);
  }
});

test("a custom timetable runs on its days and honours the daily cap", () => {
  const weekdays = parseLocalSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Paris" });
  const saturday = Date.UTC(2026, 8, 5, 12, 0);
  assert.equal(wall(nextLocalOccurrence(weekdays, saturday) ?? 0, "Europe/Paris"), "2026-09-07 09:00");
  const capped = parseLocalSchedule({ kind: "cron", expression: "0 */2 * * *", timezone: "UTC", maxPerDay: 3 });
  assert.deepEqual(localOccurrences(capped, { after: Date.UTC(2026, 8, 4, 0, 0), count: 4 }).map((value) => wall(value, "UTC")), [
    "2026-09-04 02:00",
    "2026-09-04 04:00",
    "2026-09-05 00:00",
    "2026-09-05 02:00",
  ]);
  const firstOfMonth = parseLocalSchedule({ kind: "cron", expression: "30 8 1 * *", timezone: "UTC" });
  assert.equal(wall(nextLocalOccurrence(firstOfMonth, Date.UTC(2026, 8, 4, 0, 0)) ?? 0, "UTC"), "2026-10-01 08:30");
  // Day of month and day of week together mean either, as cron does.
  const either = parseLocalSchedule({ kind: "cron", expression: "0 12 15 * 1", timezone: "UTC" });
  assert.deepEqual(localOccurrences(either, { after: Date.UTC(2026, 8, 13, 0, 0), count: 2 }).map((value) => wall(value, "UTC")), [
    "2026-09-14 12:00",
    "2026-09-15 12:00",
  ]);
  // Shared kinds still come from the shared contract.
  const daily = parseLocalSchedule({ kind: "daily", hour: 16, minute: 30, timezone: "UTC" });
  assert.equal(nextLocalOccurrence(daily, Date.UTC(2026, 8, 1, 15, 0)), Date.UTC(2026, 8, 1, 16, 30));
  assert.equal(localOccurrences(daily, { after: Date.UTC(2026, 8, 1, 15, 0), count: 7 }).length, 7);
});

test("guardrails refuse a schedule under the minimum gap or over the daily cap with a sentence to relay", () => {
  const now = Date.UTC(2026, 8, 4, 8, 0);
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "daily", hour: 9, minute: 0, timezone: "UTC" }), guardrails, now), { ok: true });
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "interval", everyMinutes: 120, from: "09:00", until: "18:00", timezone: "UTC" }), guardrails, now), { ok: true });
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "interval", everyMinutes: 60, maxPerDay: 6, timezone: "UTC" }), guardrails, now), {
    ok: false,
    reason: "Assignments on this Mac can run at most 4 times a day; this schedule asks for 6.",
  });
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "cron", expression: "*/30 * * * *", timezone: "UTC", maxPerDay: 4 }), guardrails, now), {
    ok: false,
    reason: "Runs on this Mac need at least 1 hour between them; this schedule would run them 30 minutes apart.",
  });
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "cron", expression: "*/30 * * * *", timezone: "UTC", maxPerDay: 4 }), { minimumGapMinutes: 30, maxRunsPerDay: 4 }, now), { ok: true });
  assert.deepEqual(checkScheduleGuardrails(parseLocalSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" }), { minimumGapMinutes: 15, maxRunsPerDay: 1 }, now), {
    ok: false,
    reason: "Assignments on this Mac can run at most once a day; this schedule asks for 4.",
  });
});
