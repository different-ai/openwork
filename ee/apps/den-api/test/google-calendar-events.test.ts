import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCalendarEventPayload, calendarRecurrenceMatches, calendarRecurrenceSchema, calendarRruleSchema, createCalendarEventBodySchema, recurrenceToRrule } from "../src/capability-sources/google-calendar-events.js"
import { extractCalendarEvents } from "../src/capability-sources/google-workspace-api.js"

const event = { summary: "Weekly review", start: "2026-11-02T09:00:00-05:00", end: "2026-11-02T09:30:00-05:00" }

test("structured recurrence converts each frequency with finite count, interval and weekdays", () => {
  for (const frequency of ["daily", "weekly", "monthly", "yearly"]) {
    const recurrence = calendarRecurrenceSchema.parse({ frequency, interval: 2, byWeekday: ["MO", "WE", "MO"], count: 10 })
    assert.deepEqual(recurrenceToRrule(recurrence), [`RRULE:FREQ=${frequency.toUpperCase()};INTERVAL=2;BYDAY=MO,WE;COUNT=10`])
  }
  assert.deepEqual(recurrenceToRrule(calendarRecurrenceSchema.parse({ frequency: "daily", count: 1 })), ["RRULE:FREQ=DAILY;COUNT=1"])
  assert.deepEqual(recurrenceToRrule(calendarRecurrenceSchema.parse({ frequency: "daily", until: "2026-12-01T09:00:00-05:00" })), ["RRULE:FREQ=DAILY;UNTIL=20261201T140000Z"])
  assert.deepEqual(recurrenceToRrule(calendarRecurrenceSchema.parse({ frequency: "weekly", until: "2026-12-01" })), ["RRULE:FREQ=WEEKLY;UNTIL=20261201T235959Z"])
})

test("structured recurrence rejects unbounded series, conflicting ends, invalid dates and out-of-range fields", () => {
  for (const recurrence of [
    { frequency: "weekly" }, { frequency: "weekly", count: 10, until: "2026-12-01" },
    { frequency: "hourly", count: 10 }, { frequency: "weekly", count: 0 }, { frequency: "weekly", count: 731 },
    { frequency: "weekly", count: 1.5 }, { frequency: "weekly", count: 10, interval: 0 },
    { frequency: "weekly", count: 10, interval: 100 }, { frequency: "weekly", count: 10, byWeekday: ["Monday"] },
    { frequency: "weekly", count: 10, byWeekday: [] }, { frequency: "weekly", until: "2026-02-30" },
    { frequency: "weekly", until: "2026-12-01T10:00:00" }, { frequency: "weekly", count: 10, forever: true },
  ]) assert.equal(calendarRecurrenceSchema.safeParse(recurrence).success, false, JSON.stringify(recurrence))
})

test("payload keeps one-time events unchanged and adds recurrence plus both time zones for a series", () => {
  assert.deepEqual(buildCalendarEventPayload(createCalendarEventBodySchema.parse(event)), {
    summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end },
  })
  const recurring = buildCalendarEventPayload(createCalendarEventBodySchema.parse({ ...event, description: "Review", location: "Online", timeZone: "America/New_York", attendees: ["member@example.test"], recurrence: { frequency: "weekly", byWeekday: ["MO", "WE"], count: 10 }, createMeetLink: true }))
  assert.deepEqual(recurring, { summary: event.summary, description: "Review", location: "Online", start: { dateTime: event.start, timeZone: "America/New_York" }, end: { dateTime: event.end, timeZone: "America/New_York" }, attendees: [{ email: "member@example.test" }], recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"] })
  const rrule = ["RRULE:FREQ=WEEKLY;COUNT=10", "EXDATE:20261109T140000Z", "RDATE:20261110T140000Z"]
  assert.deepEqual(buildCalendarEventPayload(createCalendarEventBodySchema.parse({ ...event, timeZone: "America/New_York", rrule })).recurrence, rrule)
})

test("create validation gives actionable missing-zone and mutually-exclusive errors", () => {
  for (const fields of [{ recurrence: { frequency: "weekly", count: 10 } }, { rrule: ["RRULE:FREQ=WEEKLY;COUNT=10"] }]) {
    const result = createCalendarEventBodySchema.safeParse({ ...event, ...fields })
    assert.equal(result.success, false)
    if (!result.success) assert.match(result.error.message, /IANA timeZone/)
  }
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "Not/A_Zone", recurrence: { frequency: "weekly", count: 10 } }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "UTC", recurrence: { frequency: "weekly", count: 10 }, rrule: ["RRULE:FREQ=DAILY;COUNT=10"] }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "+01:00", recurrence: { frequency: "weekly", count: 10 } }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "UTC", rrule: ["RRULE:UNTIL=20261101T000000Z;FREQ=WEEKLY"] }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "UTC", recurrence: { frequency: "weekly", until: "not-a-date" } }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, end: event.start }).success, false)
  assert.equal(createCalendarEventBodySchema.safeParse({ ...event, timeZone: "UTC", recurrence: { frequency: "weekly", until: "2026-11-01" } }).success, false)
})

test("raw recurrence is bounded and rejects injection, unsupported properties and multiple rules", () => {
  for (const rules of [
    [], ["FREQ=WEEKLY;COUNT=10"], ["RRULE:FREQ=WEEKLY"], ["RRULE:FREQ=WEEKLY;COUNT=10\nEXDATE:20261109T140000Z"],
    ["RRULE:FREQ=WEEKLY;COUNT=10\r"], ["RRULE:FREQ=WEEKLY;COUNT=10", "RRULE:FREQ=DAILY;COUNT=10"],
    ["RRULE:FREQ=WEEKLY;COUNT=731"], ["RRULE:FREQ=WEEKLY;COUNT=0"], ["RRULE:FREQ=WEEKLY;COUNT=10;COUNT=2"],
    ["RRULE:FREQ=WEEKLY;COUNT=10;UNTIL=20261201T000000Z"], ["RRULE:FREQ=WEEKLY;UNTIL=20260230T000000Z"],
    ["RRULE:FREQ=WEEKLY;UNTIL=20261201"], ["EXDATE:invalid"], ["RDATE:20260230"], ["DTSTART:20261109T140000Z"],
    ["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=BAD"], ["RRULE:FREQ=WEEKLY;COUNT=10;BYMONTH=13"],
    ["RRULE:FREQ=WEEKLY;COUNT=10;INTERVAL=0"], ["RRULE:FREQ=SECONDLY;COUNT=10"],
    ["RRULE:FREQ=WEEKLY;COUNT=10;BYDAY=1MO"], ["RRULE:FREQ=WEEKLY;COUNT=10;BYMONTHDAY=1"],
    ["RRULE:FREQ=MONTHLY;COUNT=10;BYSETPOS=1"], ["EXDATE:20261109"], ["RDATE:20261109,20261110T140000Z"],
    ["RDATE:" + "1".repeat(2048)], Array.from({ length: 33 }, () => "RDATE:20261109T140000Z"),
  ]) assert.equal(calendarRruleSchema.safeParse(rules).success, false, JSON.stringify(rules).slice(0, 200))
  assert.equal(calendarRruleSchema.safeParse(["RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;BYMONTH=1,3;INTERVAL=2;COUNT=10;WKST=MO"]).success, true)
  assert.equal(calendarRruleSchema.safeParse(["RDATE:20261109T140000Z,20261110T140000Z"]).success, true)
})

test("recurrence receipts allow provider ordering but never a missing or different rule", () => {
  const expected = ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10", "EXDATE:20261109T140000Z"]
  assert.equal(calendarRecurrenceMatches(expected, ["EXDATE:20261109T140000Z", "RRULE:COUNT=10;INTERVAL=1;BYDAY=WE,MO;FREQ=WEEKLY"]), true)
  assert.equal(calendarRecurrenceMatches(expected, null), false)
  assert.equal(calendarRecurrenceMatches(expected, ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=11"]), false)
  assert.equal(calendarRecurrenceMatches([], undefined), true)
})

test("event extraction distinguishes a series master, expanded occurrence and one-time event", () => {
  const events = extractCalendarEvents({ items: [{ id: "master", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"] }, { id: "instance", recurringEventId: "master" }, { id: "single" }] })
  assert.equal(events[0]?.recurringEventId, null)
  assert.deepEqual(events[0]?.recurrence, ["RRULE:FREQ=WEEKLY;COUNT=10"])
  assert.equal(events[1]?.recurringEventId, "master")
  assert.equal(events[1]?.recurrence, null)
  assert.equal(events[2]?.recurringEventId, null)
  assert.equal(events[2]?.recurrence, null)
})
