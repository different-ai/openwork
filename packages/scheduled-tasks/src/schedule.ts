import {
  scheduledTaskSchedulePreviewSchema,
  scheduledTaskScheduleSchema,
  type ScheduledTaskSchedule,
  type ScheduledTaskSchedulePreview,
} from "@openwork/types/scheduled-tasks"

const DAY_MS = 24 * 60 * 60 * 1_000
const SEARCH_WINDOW_HOURS = 18

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

function resolveLocalOccurrence(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
): { timestamp: number; shifted: boolean } | null {
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const start = nominal - SEARCH_WINDOW_HOURS * 60 * 60 * 1_000
  const end = nominal + SEARCH_WINDOW_HOURS * 60 * 60 * 1_000
  const targetKey = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let shifted: number | null = null

  for (let candidate = start; candidate <= end; candidate += 60_000) {
    const local = localDateTime(candidate, timezone)
    if (!sameLocalDate(local, date)) continue
    const key = localKey(local)
    if (key === targetKey) return { timestamp: candidate, shifted: false }
    if (key > targetKey && (shifted === null || candidate < shifted)) {
      shifted = candidate
    }
  }
  return shifted === null ? null : { timestamp: shifted, shifted: true }
}

function isScheduledDay(
  schedule: ScheduledTaskSchedule,
  weekday: number,
): boolean {
  return (
    schedule.kind === "daily" ||
    (schedule.kind === "weekly" && schedule.daysOfWeek.includes(weekday))
  )
}

export function assertScheduledTaskTimezone(timezone: string): void {
  try {
    formatter(timezone).format(new Date(0))
  } catch {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`)
  }
}

export interface ScheduledTaskOccurrenceSearchOptions {
  after: number
  count?: number
}

export function scheduledTaskOccurrences(
  input: ScheduledTaskSchedule,
  options: ScheduledTaskOccurrenceSearchOptions,
): { occurrences: number[]; warnings: string[] } {
  const schedule = scheduledTaskScheduleSchema.parse(input)
  assertScheduledTaskTimezone(schedule.timezone)
  const count = Math.max(0, Math.min(options.count ?? 5, 5))
  if (schedule.kind === "manual" || count === 0) {
    return { occurrences: [], warnings: [] }
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

export function nextScheduledTaskOccurrence(
  schedule: ScheduledTaskSchedule,
  after: number,
): number | null {
  return scheduledTaskOccurrences(schedule, { after, count: 1 }).occurrences[0] ?? null
}

export function previewScheduledTaskSchedule(
  input: ScheduledTaskSchedule,
  options: { after?: number; generatedAt?: number } = {},
): ScheduledTaskSchedulePreview {
  const generatedAt = Math.floor(options.generatedAt ?? Date.now())
  const schedule = scheduledTaskScheduleSchema.parse(input)
  const result = scheduledTaskOccurrences(schedule, {
    after: Math.floor(options.after ?? generatedAt),
    count: 5,
  })
  return scheduledTaskSchedulePreviewSchema.parse({
    schedule,
    generatedAt,
    occurrences: result.occurrences,
    warnings: result.warnings,
  })
}

export const SCHEDULED_TASK_DAY_MS = DAY_MS
