import {
  automationScheduleSchema,
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

function isScheduledDay(
  schedule: AutomationSchedule,
  weekday: number,
): boolean {
  return (
    schedule.kind === "daily" ||
    (schedule.kind === "weekly" && schedule.daysOfWeek.includes(weekday))
  )
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

  const after = Math.floor(options.after)
  const start = localDateTime(after, schedule.timezone)
  const occurrences: number[] = []
  const warnings = new Set<string>()

  for (let offset = 0; offset < 370 && occurrences.length < count; offset += 1) {
    const date = addLocalDays(start, offset)
    const weekday = new Date(
      Date.UTC(date.year, date.month - 1, date.day),
    ).getUTCDay()
    if (!isScheduledDay(schedule, weekday)) continue
    const resolved = resolveLocalOccurrence(
      date,
      schedule.hour,
      schedule.minute,
      schedule.timezone,
    )
    if (!resolved || resolved.timestamp <= after) continue
    if (resolved.shifted) {
      warnings.add(
        `A wall-clock occurrence falls inside a daylight-saving transition and was shifted to the next valid minute in ${schedule.timezone}.`,
      )
    }
    occurrences.push(resolved.timestamp)
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

  const occurrences: number[] = []
  const warnings = new Set<string>()
  // A local day can start up to ~14h either side of UTC midnight; start one day
  // early and stop one day late so the edges of the range are always covered.
  const first = addLocalDays(localDateTime(from, schedule.timezone), -1)
  const last = addLocalDays(localDateTime(to, schedule.timezone), 1)
  const lastKey = Date.UTC(last.year, last.month - 1, last.day)
  for (let date = first; Date.UTC(date.year, date.month - 1, date.day) <= lastKey; date = addLocalDays(date, 1)) {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    if (!isScheduledDay(schedule, weekday)) continue
    const resolved = resolveLocalOccurrence(date, schedule.hour, schedule.minute, schedule.timezone)
    if (!resolved || resolved.timestamp < from || resolved.timestamp >= to) continue
    if (occurrences.length >= limit) {
      truncated = true
      break
    }
    if (resolved.shifted) {
      warnings.add(
        `A wall-clock occurrence falls inside a daylight-saving transition and was shifted to the next valid minute in ${schedule.timezone}.`,
      )
    }
    occurrences.push(resolved.timestamp)
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
