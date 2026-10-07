import type { AutomationSchedule } from "@openwork/types/automations"

import { compareDates, type CalendarRange, type LocalDate } from "./time"

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function timeOfDay(hour: number, minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, hour, minute)))
}

/** Short zone label for a schedule's zone, e.g. "PT" style "PDT", or the IANA name when Intl has none. */
export function timeZoneLabel(timeZone: string, at = Date.now(), locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale ?? "en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(at))
      .find((entry) => entry.type === "timeZoneName")
    return part?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** "Every Friday at 3:00 PM PDT", "Every weekday at 9:00 AM", "Once on Thu, Oct 8 at 4:00 PM". */
export function describeSchedule(schedule: AutomationSchedule, displayTimeZone: string, locale?: string): string {
  const zone = schedule.timezone === displayTimeZone ? "" : ` ${timeZoneLabel(schedule.timezone, Date.now(), locale)}`
  if (schedule.kind === "once") {
    return `Once on ${new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: schedule.timezone }).format(new Date(schedule.at))}${zone}`
  }
  const at = `${timeOfDay(schedule.hour, schedule.minute, locale)}${zone}`
  if (schedule.kind === "daily") return `Every day at ${at}`
  const days = [...schedule.daysOfWeek].sort((left, right) => left - right)
  if (days.length === 7) return `Every day at ${at}`
  if (days.join(",") === "1,2,3,4,5") return `Every weekday at ${at}`
  if (days.join(",") === "0,6") return `Every weekend day at ${at}`
  if (days.length === 1) return `Every ${WEEKDAY_NAMES[days[0]!]} at ${at}`
  return `Every ${days.map((day) => WEEKDAY_SHORT[day]).join(", ")} at ${at}`
}

export function formatInstant(instant: number, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(instant))
}

export function formatTime(instant: number, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(instant))
}

export function formatHourLabel(hour: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, hour)))
}

function utcDate(date: LocalDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 12))
}

export function formatDayHeader(date: LocalDate, locale?: string) {
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(utcDate(date)),
    day: String(date.day),
  }
}

export function formatDate(date: LocalDate, locale?: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(utcDate(date))
}

/** "Oct 5 – 11, 2026", "Sep 28 – Oct 4, 2026", "Wednesday, October 7, 2026", "October 2026". */
export function formatRangeLabel(range: CalendarRange, anchor: LocalDate, locale?: string): string {
  if (range.view === "day") return formatDate(anchor, locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
  if (range.view === "month") return formatDate(anchor, locale, { month: "long", year: "numeric" })
  const first = range.days[0]!
  const last = range.days.at(-1)!
  const sameMonth = first.month === last.month && first.year === last.year
  const start = formatDate(first, locale, { month: "short", day: "numeric", ...(first.year !== last.year ? { year: "numeric" } : {}) })
  const end = sameMonth ? String(last.day) : formatDate(last, locale, { month: "short", day: "numeric" })
  return `${start} – ${end}, ${last.year}`
}

export function isSameDate(left: LocalDate, right: LocalDate): boolean {
  return compareDates(left, right) === 0
}
