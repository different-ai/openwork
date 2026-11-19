/**
 * Time helpers for the Calendar. Everything is Intl-based (no date library):
 * the grid works in one display time zone, events and Automation runs are
 * absolute instants, and all-day events are calendar dates.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export type CalendarView = "day" | "week" | "month"

/** A calendar date in the display zone, e.g. { year: 2026, month: 10, day: 7 }. */
export type LocalDate = { year: number; month: number; day: number }

const partFormatters = new Map<string, Intl.DateTimeFormat>()

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = partFormatters.get(timeZone)
  if (existing) return existing
  const created = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  })
  partFormatters.set(timeZone, created)
  return created
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    partFormatter(timeZone)
    return true
  } catch {
    return false
  }
}

export function zonedParts(instant: number, timeZone: string) {
  const parts = new Map(partFormatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  }
}

export function localDateOf(instant: number, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(instant, timeZone)
  return { year, month, day }
}

function offsetMs(instant: number, timeZone: string): number {
  const second = Math.floor(instant / 1_000) * 1_000
  const parts = zonedParts(second, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - second
}

/**
 * The instant a wall-clock time names in a zone. Repeated times (DST
 * fall-back) resolve to the first instant; skipped times (spring-forward) move
 * forward by the gap, matching how calendars render them.
 */
export function zonedTimeToInstant(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number; millisecond?: number },
  timeZone: string,
): number {
  const nominal = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0, wall.millisecond ?? 0)
  const offsets = [...new Set([offsetMs(nominal - 14 * HOUR_MS, timeZone), offsetMs(nominal, timeZone), offsetMs(nominal + 14 * HOUR_MS, timeZone)])]
  const exact = offsets
    .map((offset) => nominal - offset)
    .filter((candidate) => nominal - offsetMs(candidate, timeZone) === candidate)
    .sort((left, right) => left - right)
  if (exact[0] !== undefined) return exact[0]
  // Skipped wall time: apply the offset from before the gap, which lands after it.
  return nominal - Math.min(...offsets)
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

export function dateKey(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
}

export function parseDateKey(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day))
  return check.getUTCMonth() + 1 === date.month && check.getUTCDate() === date.day ? date : null
}

export function compareDates(left: LocalDate, right: LocalDate): number {
  return Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day)
}

export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/** Start of the local day as an instant (not always midnight + 24h apart: DST). */
export function startOfDay(date: LocalDate, timeZone: string): number {
  return zonedTimeToInstant(date, timeZone)
}

export type CalendarRange = {
  view: CalendarView
  /** Days rendered, in order. Month view includes leading/trailing days of adjacent months. */
  days: LocalDate[]
  /** Inclusive start instant of the first day. */
  start: number
  /** Exclusive end instant (start of the day after the last). */
  end: number
}

/** The visible range for a view anchored on `anchor`, weeks starting on `weekStartsOn` (0 = Sunday). */
export function calendarRange(view: CalendarView, anchor: LocalDate, timeZone: string, weekStartsOn = 1): CalendarRange {
  let first: LocalDate
  let count: number
  if (view === "day") {
    first = anchor
    count = 1
  } else if (view === "week") {
    first = addDays(anchor, -((weekdayOf(anchor) - weekStartsOn + 7) % 7))
    count = 7
  } else {
    const monthStart = { year: anchor.year, month: anchor.month, day: 1 }
    first = addDays(monthStart, -((weekdayOf(monthStart) - weekStartsOn + 7) % 7))
    const nextMonth = addDays({ year: anchor.year, month: anchor.month, day: 28 }, 4)
    const monthEnd = addDays({ year: nextMonth.year, month: nextMonth.month, day: 1 }, -1)
    const lastWeekEnd = addDays(monthEnd, (weekStartsOn + 6 - weekdayOf(monthEnd) + 7) % 7)
    count = Math.round(compareDates(lastWeekEnd, first) / DAY_MS) + 1
  }
  const days = Array.from({ length: count }, (_, index) => addDays(first, index))
  return { view, days, start: startOfDay(first, timeZone), end: startOfDay(addDays(first, count), timeZone) }
}

export function shiftAnchor(view: CalendarView, anchor: LocalDate, direction: -1 | 1): LocalDate {
  if (view === "day") return addDays(anchor, direction)
  if (view === "week") return addDays(anchor, 7 * direction)
  const month = anchor.month + direction
  const year = anchor.year + Math.floor((month - 1) / 12)
  const normalizedMonth = ((month - 1) % 12 + 12) % 12 + 1
  return { year, month: normalizedMonth, day: 1 }
}

/** Minutes since local midnight of `date` for an instant, clamped to the day (handles 23h/25h days). */
export function minutesIntoDay(instant: number, date: LocalDate, timeZone: string): number {
  const start = startOfDay(date, timeZone)
  const end = startOfDay(addDays(date, 1), timeZone)
  const clamped = Math.min(Math.max(instant, start), end)
  return (clamped - start) / MINUTE_MS
}

export function dayLengthMinutes(date: LocalDate, timeZone: string): number {
  return (startOfDay(addDays(date, 1), timeZone) - startOfDay(date, timeZone)) / MINUTE_MS
}

/**
 * Microsoft Graph returns `{ dateTime, timeZone }` pairs where the zone may be
 * "UTC", an IANA name, or a Windows zone name. Den's calendarView sends no
 * Prefer header, so it is "UTC" today; the others are handled for safety.
 * Unknown zones fall back to UTC rather than the browser's zone.
 */
const WINDOWS_TIME_ZONES: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Israel Standard Time": "Asia/Jerusalem",
  "Russian Standard Time": "Europe/Moscow",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "SA Pacific Standard Time": "America/Bogota",
  "Central America Standard Time": "America/Guatemala",
  "South Africa Standard Time": "Africa/Johannesburg",
}

export function resolveGraphTimeZone(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "UTC"
  const mapped = WINDOWS_TIME_ZONES[trimmed]
  if (mapped) return mapped
  return isValidTimeZone(trimmed) ? trimmed : "UTC"
}

const GRAPH_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/

/** Parses a Graph wall time (`2026-10-05T16:00:00.0000000`, no offset) in its zone. */
export function parseGraphDateTime(dateTime: string, timeZone: string): number | null {
  const match = GRAPH_DATE_TIME.exec(dateTime.trim())
  if (!match) return null
  const millisecond = match[7] ? Math.round(Number(`0.${match[7]}`) * 1_000) : 0
  return zonedTimeToInstant({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0), millisecond,
  }, resolveGraphTimeZone(timeZone))
}

export function toUtcIso(instant: number): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, "Z")
}
