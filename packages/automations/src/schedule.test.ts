import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { AutomationSchedule } from "@openwork/types/automations"
import {
  AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS,
  automationOccurrences,
  automationOccurrencesInRange,
  nextAutomationOccurrence,
} from "./schedule.ts"

const HOUR = 60 * 60 * 1_000
const DAY = 24 * HOUR

/**
 * The scheduler's previous resolver, kept verbatim as an oracle: it scanned
 * every minute within ±18h of the nominal time. The fast resolver must agree
 * with it exactly, including DST gaps (shift to the next valid minute) and
 * overlaps (first instant wins).
 */
function bruteForceOccurrence(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  const format = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  })
  const local = (timestamp: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]))
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) }
  }
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let shifted: number | null = null
  for (let candidate = target - 18 * HOUR; candidate <= target + 18 * HOUR; candidate += 60_000) {
    const value = local(candidate)
    if (value.year !== date.year || value.month !== date.month || value.day !== date.day) continue
    const key = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute)
    if (key === target) return candidate
    if (key > target && (shifted === null || candidate < shifted)) shifted = candidate
  }
  return shifted
}

function localDate(timestamp: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

describe("automationOccurrencesInRange", () => {
  test("daily schedule yields one occurrence per local day in a week", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "America/Los_Angeles", hour: 9, minute: 0 }
    // Mon 2026-10-05 00:00 PDT .. Mon 2026-10-12 00:00 PDT
    const from = Date.parse("2026-10-05T07:00:00Z")
    const to = Date.parse("2026-10-12T07:00:00Z")
    const result = automationOccurrencesInRange(schedule, { from, to })
    assert.equal(result.occurrences.length, 7)
    assert.equal(result.truncated, false)
    assert.equal(new Date(result.occurrences[0]!).toISOString(), "2026-10-05T16:00:00.000Z")
    assert.equal(new Date(result.occurrences[6]!).toISOString(), "2026-10-11T16:00:00.000Z")
  })

  test("weekday schedule respects Sunday = 0 and the exclusive end", () => {
    const schedule: AutomationSchedule = { kind: "weekly", timezone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
    const from = Date.parse("2026-10-04T07:00:00Z") // Sun 00:00 PDT
    const to = Date.parse("2026-10-09T16:00:00Z") // Fri 09:00 PDT, excluded
    const result = automationOccurrencesInRange(schedule, { from, to })
    assert.deepEqual(result.occurrences.map((value) => new Date(value).toISOString()), [
      "2026-10-05T16:00:00.000Z", "2026-10-06T16:00:00.000Z", "2026-10-07T16:00:00.000Z", "2026-10-08T16:00:00.000Z",
    ])
  })

  test("a week crossing the US fall-back transition keeps 9 AM wall time", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "America/New_York", hour: 9, minute: 0 }
    // Week of 2026-10-29 .. 2026-11-05; DST ends 2026-11-01 02:00 EDT.
    const result = automationOccurrencesInRange(schedule, { from: Date.parse("2026-10-29T04:00:00Z"), to: Date.parse("2026-11-05T05:00:00Z") })
    assert.equal(result.occurrences.length, 7)
    const iso = result.occurrences.map((value) => new Date(value).toISOString())
    assert.equal(iso[2], "2026-10-31T13:00:00.000Z") // EDT, UTC-4
    assert.equal(iso[3], "2026-11-01T14:00:00.000Z") // EST, UTC-5
  })

  test("a nonexistent spring-forward time shifts to the first valid minute and warns", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "America/Los_Angeles", hour: 2, minute: 30 }
    const result = automationOccurrencesInRange(schedule, { from: Date.parse("2027-03-13T08:00:00Z"), to: Date.parse("2027-03-15T07:00:00Z") })
    assert.deepEqual(result.occurrences.map((value) => new Date(value).toISOString()), [
      "2027-03-13T10:30:00.000Z", // Sat 02:30 PST
      "2027-03-14T10:00:00.000Z", // Sun 02:30 does not exist; 03:00 PDT
    ])
    assert.equal(result.warnings.length, 1)
  })

  test("an ambiguous fall-back time resolves to its first instant", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "America/Los_Angeles", hour: 1, minute: 30 }
    const result = automationOccurrencesInRange(schedule, { from: Date.parse("2026-11-01T07:00:00Z"), to: Date.parse("2026-11-02T08:00:00Z") })
    assert.equal(new Date(result.occurrences[0]!).toISOString(), "2026-11-01T08:30:00.000Z") // 01:30 PDT, not PST
  })

  test("once schedules use [from, to)", () => {
    const at = Date.parse("2026-10-07T15:00:00Z")
    const schedule: AutomationSchedule = { kind: "once", timezone: "UTC", at }
    assert.deepEqual(automationOccurrencesInRange(schedule, { from: at, to: at + 1 }).occurrences, [at])
    assert.deepEqual(automationOccurrencesInRange(schedule, { from: at - 1, to: at }).occurrences, [])
  })

  test("limit and maximum range report truncation", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "UTC", hour: 0, minute: 0 }
    const from = Date.parse("2026-01-01T00:00:00Z")
    const limited = automationOccurrencesInRange(schedule, { from, to: from + 10 * DAY, limit: 3 })
    assert.equal(limited.occurrences.length, 3)
    assert.equal(limited.truncated, true)
    const long = automationOccurrencesInRange(schedule, { from, to: from + 1000 * DAY, limit: 10_000 })
    assert.equal(long.truncated, true)
    assert.equal(long.occurrences.length, AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS)
  })

  test("half-hour and southern-hemisphere zones match the scheduler oracle across a year", () => {
    for (const timezone of ["Australia/Adelaide", "Asia/Kolkata", "Europe/London", "America/Sao_Paulo", "Pacific/Chatham", "Australia/Lord_Howe"]) {
      for (const [hour, minute] of [[0, 0], [1, 30], [2, 15], [2, 45], [23, 59]] as const) {
        const schedule: AutomationSchedule = { kind: "daily", timezone, hour, minute }
        const from = Date.parse("2026-01-01T00:00:00Z")
        const { occurrences } = automationOccurrencesInRange(schedule, { from, to: from + 366 * DAY })
        for (const occurrence of occurrences.filter((_, index) => index % 23 === 0)) {
          const date = localDate(occurrence, timezone)
          assert.equal(occurrence, bruteForceOccurrence(date, hour, minute, timezone), `${timezone} ${hour}:${minute} ${JSON.stringify(date)}`)
        }
      }
    }
  })

  test("every DST transition day in 2026–2027 matches the scheduler oracle", () => {
    const transitions: Array<[string, string]> = [
      ["America/Los_Angeles", "2026-11-01"], ["America/Los_Angeles", "2027-03-14"],
      ["Europe/Berlin", "2026-10-25"], ["Europe/Berlin", "2027-03-28"],
      ["Australia/Sydney", "2026-10-04"], ["Australia/Sydney", "2027-04-04"],
      ["Australia/Lord_Howe", "2026-10-04"], ["America/Santiago", "2026-09-06"],
    ]
    for (const [timezone, day] of transitions) {
      const [year, month, date] = day.split("-").map(Number)
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const hour = Math.floor(minutes / 60)
        const minute = minutes % 60
        const expected = bruteForceOccurrence({ year: year!, month: month!, day: date! }, hour, minute, timezone)
        const actual = automationOccurrencesInRange({ kind: "daily", timezone, hour, minute }, {
          from: Date.UTC(year!, month! - 1, date! - 1), to: Date.UTC(year!, month! - 1, date! + 2),
        }).occurrences.find((value) => {
          const local = localDate(value, timezone)
          return local.year === year && local.month === month && local.day === date
        }) ?? null
        assert.equal(actual, expected, `${timezone} ${day} ${hour}:${minute}`)
      }
    }
  })
})

describe("scheduler helpers share the resolver", () => {
  test("nextAutomationOccurrence agrees with the range API", () => {
    const schedule: AutomationSchedule = { kind: "weekly", timezone: "Europe/Berlin", daysOfWeek: [0, 3], hour: 2, minute: 30 }
    let after = Date.parse("2026-10-01T00:00:00Z")
    const range = automationOccurrencesInRange(schedule, { from: after + 1, to: after + 60 * DAY }).occurrences
    for (const expected of range) {
      const next = nextAutomationOccurrence(schedule, after)
      assert.equal(next, expected)
      after = expected
    }
  })

  test("automationOccurrences still caps previews at five", () => {
    const schedule: AutomationSchedule = { kind: "daily", timezone: "UTC", hour: 12, minute: 0 }
    assert.equal(automationOccurrences(schedule, { after: 0, count: 50 }).occurrences.length, 5)
  })
})
