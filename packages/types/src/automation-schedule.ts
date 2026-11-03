import {
  automationScheduleSchema,
  type AutomationCalendarSchedule,
  type AutomationSchedule,
} from "@openwork/types/automations"

const DAY_MS = 24 * 60 * 60 * 1_000

type LocalDate = { year: number; month: number; day: number }
type LocalDateTime = LocalDate & {
  hour: number
  minute: number
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone)
  if (existing) return existing
  const created = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  })
  formatters.set(timezone, created)
  return created
}

function localDateTime(timestamp: number, timezone: string): LocalDateTime {
  const values = new Map(
    formatter(timezone)
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    values.get("weekday") ?? "",
  )
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    weekday,
  }
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  }
}

function localKey(
  value: Pick<LocalDateTime, "year" | "month" | "day" | "hour" | "minute">,
): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute)
}

function sameLocalDate(left: LocalDate, right: LocalDate): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day
  )
}

/** Zone offset (local minus UTC) at a minute-aligned instant, in milliseconds. */
function zoneOffsetMs(timestamp: number, timezone: string): number {
  const minute = Math.floor(timestamp / 60_000) * 60_000
  return localKey(localDateTime(minute, timezone)) - minute
}

const OFFSET_PROBE_MS = 14 * 60 * 60 * 1_000

/**
 * Resolves one wall-clock occurrence in an IANA zone without scanning.
 *
 * Semantics (shared by the scheduler, previews and the calendar range API):
 * - an ambiguous time (DST fall-back repeats it) resolves to its first instant;
 * - a nonexistent time (DST spring-forward skips it) shifts to the first valid
 *   minute after the gap, reported as `shifted`.
 *
 * The instant must lie within ±14h of the nominal UTC wall time, so the zone
 * offsets sampled at both ends (and the middle) contain every candidate offset.
 */
function resolveLocalOccurrence(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
): { timestamp: number; shifted: boolean } | null {
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const offsets = [...new Set([
    zoneOffsetMs(nominal - OFFSET_PROBE_MS, timezone),
    zoneOffsetMs(nominal, timezone),
    zoneOffsetMs(nominal + OFFSET_PROBE_MS, timezone),
  ])]
  const exact = offsets
    .map((offset) => nominal - offset)
    .filter((candidate) => localKey(localDateTime(candidate, timezone)) === nominal)
    .sort((left, right) => left - right)
  if (exact[0] !== undefined) return { timestamp: exact[0], shifted: false }

  // Nonexistent wall time: binary-search the transition between the two offsets.
  const candidates = offsets.map((offset) => nominal - offset)
  let low = Math.min(...candidates)
  let high = Math.max(...candidates)
  if (localKey(localDateTime(high, timezone)) <= nominal) return null
  if (localKey(localDateTime(low, timezone)) > nominal) {
    const local = localDateTime(low, timezone)
    return sameLocalDate(local, date) ? { timestamp: low, shifted: true } : null
  }
  // Invariant: key(low) <= nominal < key(high), both minute aligned.
  while (high - low > 60_000) {
    const middle = low + Math.floor((high - low) / 120_000) * 60_000
    if (localKey(localDateTime(middle, timezone)) > nominal) high = middle
    else low = middle
  }
  return sameLocalDate(localDateTime(high, timezone), date) ? { timestamp: high, shifted: true } : null
}

/** Schedules that repeat on the clock; a calendar trigger has no clock occurrences. */
type RecurringSchedule = Exclude<AutomationSchedule, { kind: "once" | "calendar" }>

function isScheduledDay(schedule: RecurringSchedule, weekday: number): boolean {
  return schedule.kind === "daily" || schedule.daysOfWeek.includes(weekday)
}

/** The wall-clock times a recurring schedule runs on each of its days, earliest first. */
function wallTimesOfDay(schedule: RecurringSchedule): { hour: number; minute: number }[] {
  if (schedule.kind !== "interval") return [{ hour: schedule.hour, minute: schedule.minute }]
  const times: { hour: number; minute: number }[] = []
  for (let hour = schedule.startHour; hour < schedule.endHour; hour += schedule.everyHours) {
    times.push({ hour, minute: 0 })
  }
  return times
}

const SHIFTED_WARNING = (timezone: string) =>
  `A wall-clock occurrence falls inside a daylight-saving transition and was shifted to the next valid minute in ${timezone}.`

/**
 * Every occurrence of one local day, earliest first. Two wall times can
 * resolve to the same instant when a daylight-saving gap shifts one onto the
 * next; that instant counts once.
 */
function occurrencesOnLocalDay(
  schedule: RecurringSchedule,
  date: LocalDate,
): { timestamp: number; shifted: boolean }[] {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  if (!isScheduledDay(schedule, weekday)) return []
  const resolved: { timestamp: number; shifted: boolean }[] = []
  for (const time of wallTimesOfDay(schedule)) {
    const occurrence = resolveLocalOccurrence(date, time.hour, time.minute, schedule.timezone)
    if (!occurrence) continue
    const previous = resolved.at(-1)
    if (previous && occurrence.timestamp <= previous.timestamp) continue
    resolved.push(occurrence)
  }
  return resolved
}

export function assertAutomationTimezone(timezone: string): void {
  try {
    formatter(timezone).format(new Date(0))
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`)
  }
}

export interface AutomationOccurrenceSearchOptions {
  after: number
  count?: number
}

export function automationOccurrences(
  input: AutomationSchedule,
  options: AutomationOccurrenceSearchOptions,
): { occurrences: number[]; warnings: string[] } {
  const schedule = automationScheduleSchema.parse(input)
  assertAutomationTimezone(schedule.timezone)
  const count = Math.max(0, Math.min(options.count ?? 5, 5))
  if (count === 0) {
    return { occurrences: [], warnings: [] }
  }

  if (schedule.kind === "once") {
    return { occurrences: schedule.at > options.after ? [schedule.at] : [], warnings: [] }
  }
  if (schedule.kind === "calendar") return { occurrences: [], warnings: [] }

  const after = Math.floor(options.after)
  const start = localDateTime(after, schedule.timezone)
  const occurrences: number[] = []
  const warnings = new Set<string>()

  for (let offset = 0; offset < 370 && occurrences.length < count; offset += 1) {
    for (const resolved of occurrencesOnLocalDay(schedule, addLocalDays(start, offset))) {
      if (resolved.timestamp <= after) continue
      if (occurrences.length >= count) break
      if (resolved.shifted) warnings.add(SHIFTED_WARNING(schedule.timezone))
      occurrences.push(resolved.timestamp)
    }
  }

  return { occurrences, warnings: [...warnings] }
}

export interface AutomationOccurrenceRangeOptions {
  /** Inclusive lower bound (epoch ms). */
  from: number
  /** Exclusive upper bound (epoch ms). */
  to: number
  /** Maximum occurrences to return; the result says when more existed. */
  limit?: number
}

export const AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS = 400
export const AUTOMATION_OCCURRENCE_RANGE_DEFAULT_LIMIT = 1_000

/**
 * Every scheduled occurrence in `[from, to)`, using exactly the scheduler's
 * wall-clock resolution (see `resolveLocalOccurrence`). Cost is one resolution
 * per local calendar day in the range, never a minute scan. Ranges longer than
 * AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS are clipped and reported as truncated.
 */
export function automationOccurrencesInRange(
  input: AutomationSchedule,
  options: AutomationOccurrenceRangeOptions,
): { occurrences: number[]; truncated: boolean; warnings: string[] } {
  const schedule = automationScheduleSchema.parse(input)
  assertAutomationTimezone(schedule.timezone)
  const limit = Math.max(0, Math.floor(options.limit ?? AUTOMATION_OCCURRENCE_RANGE_DEFAULT_LIMIT))
  const from = Math.floor(options.from)
  const requestedTo = Math.floor(options.to)
  const to = Math.min(requestedTo, from + AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS * DAY_MS)
  let truncated = to < requestedTo
  if (!(to > from) || limit === 0) return { occurrences: [], truncated, warnings: [] }

  if (schedule.kind === "once") {
    return { occurrences: schedule.at >= from && schedule.at < to ? [schedule.at] : [], truncated, warnings: [] }
  }
  if (schedule.kind === "calendar") return { occurrences: [], truncated, warnings: [] }

  const occurrences: number[] = []
  const warnings = new Set<string>()
  // A local day can start up to ~14h either side of UTC midnight; start one day
  // early and stop one day late so the edges of the range are always covered.
  const first = addLocalDays(localDateTime(from, schedule.timezone), -1)
  const last = addLocalDays(localDateTime(to, schedule.timezone), 1)
  const lastKey = Date.UTC(last.year, last.month - 1, last.day)
  days: for (let date = first; Date.UTC(date.year, date.month - 1, date.day) <= lastKey; date = addLocalDays(date, 1)) {
    for (const resolved of occurrencesOnLocalDay(schedule, date)) {
      if (resolved.timestamp < from || resolved.timestamp >= to) continue
      if (occurrences.length >= limit) {
        truncated = true
        break days
      }
      if (resolved.shifted) warnings.add(SHIFTED_WARNING(schedule.timezone))
      occurrences.push(resolved.timestamp)
    }
  }
  return { occurrences, truncated, warnings: [...warnings] }
}

export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  after: number,
): number | null {
  return automationOccurrences(schedule, { after, count: 1 }).occurrences[0] ?? null
}

export function previewAutomationSchedule(
  input: AutomationSchedule,
  options: { after?: number; generatedAt?: number } = {},
): { schedule: AutomationSchedule; generatedAt: number; occurrences: number[]; warnings: string[] } {
  const generatedAt = Math.floor(options.generatedAt ?? Date.now())
  const schedule = automationScheduleSchema.parse(input)
  const result = automationOccurrences(schedule, {
    after: Math.floor(options.after ?? generatedAt),
    count: 5,
  })
  return {
    schedule,
    generatedAt,
    occurrences: result.occurrences,
    warnings: result.warnings,
  }
}

/** Returns at most the latest missed occurrence; older backlog is never replayed. */
export function recoverableAutomationOccurrence(
  schedule: AutomationSchedule,
  input: { after: number; now: number },
): number | null {
  const occurrences = automationOccurrences(schedule, { after: input.after, count: 5 }).occurrences
    .filter((occurrence) => occurrence <= input.now)
  return occurrences.at(-1) ?? null
}

export const AUTOMATION_DAY_MS = DAY_MS

const SUNDAY_UTC = Date.UTC(2024, 0, 7)

/** Short weekday names for days of the week (0 = Sunday), e.g. "Mon, Wed". */
export function formatAutomationWeekdays(daysOfWeek: readonly number[], locale?: Intl.LocalesArgument): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
  return daysOfWeek.map((day) => weekday.format(new Date(SUNDAY_UTC + day * DAY_MS))).join(", ")
}

function clockLabel(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

/**
 * One-line label for a schedule, shared by the desktop app, Den web and the
 * agent's Automation listing, e.g. "Daily · 09:00 · Europe/Paris" or
 * "Every 3 hours · 09:00–18:00 · Mon, Tue, Wed, Thu, Fri · UTC". Times are in
 * the schedule's own zone, which the label always names.
 */
export function formatAutomationSchedule(schedule: AutomationSchedule, locale?: Intl.LocalesArgument): string {
  if (schedule.kind === "once") {
    const at = new Intl.DateTimeFormat(locale, {
      timeZone: schedule.timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(schedule.at))
    return `Once · ${at} · ${schedule.timezone}`
  }
  if (schedule.kind === "daily") return `Daily · ${clockLabel(schedule.hour, schedule.minute)} · ${schedule.timezone}`
  if (schedule.kind === "weekly") {
    return `Weekly · ${formatAutomationWeekdays(schedule.daysOfWeek, locale)} · ${clockLabel(schedule.hour, schedule.minute)} · ${schedule.timezone}`
  }
  if (schedule.kind === "calendar") {
    const parts = [describeCalendarMoment(schedule)]
    if (schedule.rule.withExternalAttendees) parts.push("with people outside the organization")
    if (schedule.rule.titleIncludes) parts.push(`titles containing "${schedule.rule.titleIncludes}"`)
    parts.push(schedule.timezone)
    return parts.join(" · ")
  }
  const parts = [schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`]
  if (schedule.startHour !== 0 || schedule.endHour !== 24) parts.push(`${clockLabel(schedule.startHour)}–${clockLabel(schedule.endHour)}`)
  if (schedule.daysOfWeek.length < 7) parts.push(formatAutomationWeekdays(schedule.daysOfWeek, locale))
  parts.push(schedule.timezone)
  return parts.join(" · ")
}

/**
 * When a calendar trigger runs, in words: "After each meeting (+5 min)",
 * "15 min before each meeting", "As each meeting starts".
 */
export function describeCalendarMoment(schedule: Pick<AutomationCalendarSchedule, "edge" | "offsetMinutes">): string {
  const minutes = Math.abs(schedule.offsetMinutes)
  if (schedule.edge === "end") {
    if (schedule.offsetMinutes === 0) return "After each meeting"
    return schedule.offsetMinutes > 0 ? `After each meeting (+${minutes} min)` : `${minutes} min before each meeting ends`
  }
  if (schedule.offsetMinutes === 0) return "As each meeting starts"
  return schedule.offsetMinutes < 0 ? `${minutes} min before each meeting` : `${minutes} min into each meeting`
}
