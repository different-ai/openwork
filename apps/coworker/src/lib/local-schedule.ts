/**
 * Schedules a coworker can express for work on this Mac: OpenWork's shared
 * Automation contract (once / daily / weekly) plus two local-only kinds, an
 * interval with an optional active window and a five-field custom timetable.
 * Pure and shared by the main process (store, tool server) and the renderer
 * (form, copy), so the occurrence math, the validation sentences, and the
 * guardrails exist once. The shared contract itself is never changed: Cloud
 * placement keeps it, and the local store only widens what it accepts.
 */
import { automationOccurrences } from "@openwork/automations";
import { automationScheduleSchema } from "@openwork/types/automations";
import type { AutomationSchedule } from "@openwork/types/automations";

export const INTERVAL_MINUTE_CHOICES = [60, 120, 180, 240, 360, 480, 720] as const;
export type IntervalMinutes = (typeof INTERVAL_MINUTE_CHOICES)[number];

export const DEFAULT_MAX_PER_DAY = 4;

export type TimeOfDay = { hour: number; minute: number };

export type IntervalSchedule = {
  kind: "interval";
  timezone: string;
  everyMinutes: IntervalMinutes;
  /** Active window, inclusive; the whole day when absent. */
  from?: TimeOfDay;
  until?: TimeOfDay;
  /** 0 = Sunday … 6 = Saturday; every day when absent. */
  daysOfWeek?: number[];
  maxPerDay: number;
};

export type CronSchedule = {
  kind: "cron";
  timezone: string;
  /** Five fields — minute, hour, day of month, month, day of week — read in `timezone`. */
  expression: string;
  maxPerDay: number;
};

export type LocalSchedule = AutomationSchedule | IntervalSchedule | CronSchedule;

/** The limits a schedule on this Mac must respect, from app settings. */
export type ScheduleGuardrails = { minimumGapMinutes: number; maxRunsPerDay: number };

/** A validation problem in words the coworker can relay to the person. */
export class ScheduleError extends Error {}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const OCCURRENCE_SEARCH_DAYS = 400;

export function isSharedSchedule(schedule: LocalSchedule): schedule is AutomationSchedule {
  return schedule.kind === "once" || schedule.kind === "daily" || schedule.kind === "weekly";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function cleanTimezone(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!isKnownTimezone(candidate)) {
    throw new ScheduleError(`"${candidate}" is not a time zone I know. Use a name such as Europe/Paris or America/New_York.`);
  }
  return candidate;
}

/** Accepts `{ hour, minute }` or "HH:MM". */
function cleanTimeOfDay(value: unknown, label: string): TimeOfDay {
  let hour: number | null = null;
  let minute: number | null = null;
  if (typeof value === "string") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match) {
      hour = Number.parseInt(match[1] ?? "", 10);
      minute = Number.parseInt(match[2] ?? "", 10);
    }
  } else if (isRecord(value)) {
    hour = integer(value.hour);
    minute = integer(value.minute ?? 0);
  }
  if (hour === null || minute === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new ScheduleError(`The ${label} time needs an hour (0–23) and a minute (0–59), for example 09:00.`);
  }
  return { hour, minute };
}

function cleanDaysOfWeek(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ScheduleError("Days of the week are a list of numbers from 0 (Sunday) to 6 (Saturday).");
  }
  const days = value.map(integer);
  if (days.some((day) => day === null || day < 0 || day > 6)) {
    throw new ScheduleError("Days of the week are a list of numbers from 0 (Sunday) to 6 (Saturday).");
  }
  const unique = [...new Set(days.filter((day): day is number => day !== null))].sort((left, right) => left - right);
  return unique.length === 7 ? undefined : unique;
}

function cleanMaxPerDay(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_MAX_PER_DAY;
  const number = integer(value);
  if (number === null || number < 1) throw new ScheduleError("The most runs per day must be a whole number of at least 1.");
  return number;
}

function minutesOf(time: TimeOfDay): number {
  return time.hour * 60 + time.minute;
}

/**
 * Read a schedule from a person's form or a coworker's tool call. Shared kinds
 * go through the shared contract untouched (after a missing time zone is
 * filled from `defaultTimezone`); local kinds are checked here. Throws a
 * `ScheduleError` whose message is a sentence for the person.
 */
export function parseLocalSchedule(value: unknown, options: { defaultTimezone?: string } = {}): LocalSchedule {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ScheduleError("A schedule needs a kind: daily, weekly, once, interval, or cron.");
  }
  const fallbackZone = options.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const kind = value.kind;
  if (kind === "daily" || kind === "weekly" || kind === "once") {
    const timezone = cleanTimezone(value.timezone, fallbackZone);
    const parsed = automationScheduleSchema.safeParse({ ...value, timezone });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join(".") || "schedule";
      throw new ScheduleError(`The ${kind} schedule's ${field} is not right: ${issue?.message ?? "check its fields"}.`);
    }
    return parsed.data;
  }
  if (kind === "interval") {
    const everyMinutes = integer(value.everyMinutes);
    const choice = INTERVAL_MINUTE_CHOICES.find((candidate) => candidate === everyMinutes);
    if (choice === undefined) {
      throw new ScheduleError("An interval can be every 1, 2, 3, 4, 6, 8, or 12 hours (60, 120, 180, 240, 360, 480, or 720 minutes).");
    }
    const from = value.from === undefined || value.from === null ? undefined : cleanTimeOfDay(value.from, "start");
    const until = value.until === undefined || value.until === null ? undefined : cleanTimeOfDay(value.until, "end");
    if (from && until && minutesOf(from) >= minutesOf(until)) {
      throw new ScheduleError("The active window needs a start time before its end time.");
    }
    const daysOfWeek = cleanDaysOfWeek(value.daysOfWeek);
    return {
      kind: "interval",
      timezone: cleanTimezone(value.timezone, fallbackZone),
      everyMinutes: choice,
      ...(from ? { from } : {}),
      ...(until ? { until } : {}),
      ...(daysOfWeek ? { daysOfWeek } : {}),
      maxPerDay: cleanMaxPerDay(value.maxPerDay),
    };
  }
  if (kind === "cron") {
    const expression = typeof value.expression === "string" ? value.expression.trim().replace(/\s+/g, " ") : "";
    parseCronExpression(expression);
    return {
      kind: "cron",
      timezone: cleanTimezone(value.timezone, fallbackZone),
      expression,
      maxPerDay: cleanMaxPerDay(value.maxPerDay),
    };
  }
  throw new ScheduleError(`"${kind}" is not a schedule kind I know. Use daily, weekly, once, interval, or cron.`);
}

// --- Custom timetables (cron) -------------------------------------------------

export type CronField = {
  /** True for a bare `*`. */
  any: boolean;
  /** Every value the field matches, ascending. */
  values: number[];
  /** Set when the field is a single stepped term (a star or a range followed by a slash and a step). */
  step?: number;
  range?: [number, number];
};

export type CronFields = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const CRON_FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"] as const;
const CRON_BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseCronField(text: string, index: number): CronField {
  const [min, max] = CRON_BOUNDS[index] ?? [0, 0];
  const name = CRON_FIELD_NAMES[index] ?? "field";
  const fail = (): never => {
    throw new ScheduleError(`I can't read "${text}" as the ${name} of a custom timetable.`);
  };
  if (text === "*") return { any: true, values: Array.from({ length: max - min + 1 }, (_, offset) => min + offset) };
  const terms = text.split(",");
  const values = new Set<number>();
  let step: number | undefined;
  let range: [number, number] | undefined;
  for (const term of terms) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
    if (!match) fail();
    const base = match?.[1] ?? "*";
    const stepValue = match?.[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
    if (stepValue < 1) fail();
    let start = min;
    let end = max;
    if (base !== "*") {
      const [startText, endText] = base.split("-");
      start = Number.parseInt(startText ?? "", 10);
      end = endText !== undefined ? Number.parseInt(endText, 10) : match?.[2] !== undefined ? max : start;
      if (start < min || start > max || end < min || end > max || end < start) fail();
    }
    for (let candidate = start; candidate <= end; candidate += stepValue) values.add(candidate);
    if (terms.length === 1 && match?.[2] !== undefined) {
      step = stepValue;
      range = [start, end];
    }
  }
  if (index === 4 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return {
    any: false,
    values: [...values].sort((left, right) => left - right),
    ...(step !== undefined ? { step } : {}),
    ...(range ? { range } : {}),
  };
}

/** Five-field cron syntax with `*`, lists, ranges, and steps. Throws a `ScheduleError` otherwise. */
export function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new ScheduleError("A custom timetable needs five fields: minute, hour, day of month, month, and day of week.");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseCronField(part, index));
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    throw new ScheduleError("A custom timetable needs five fields: minute, hour, day of month, month, and day of week.");
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function cronMatchesDay(fields: CronFields, date: LocalDate, weekday: number): boolean {
  if (!fields.month.values.includes(date.month)) return false;
  const domMatch = fields.dayOfMonth.values.includes(date.day);
  const dowMatch = fields.dayOfWeek.values.includes(weekday);
  if (fields.dayOfMonth.any && fields.dayOfWeek.any) return true;
  if (fields.dayOfMonth.any) return dowMatch;
  if (fields.dayOfWeek.any) return domMatch;
  return domMatch || dowMatch;
}

// --- Time-zone arithmetic -----------------------------------------------------

type LocalDate = { year: number; month: number; day: number };
type LocalDateTime = LocalDate & { hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timezone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  formatters.set(timezone, created);
  return created;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localDateTime(timestamp: number, timezone: string): LocalDateTime {
  const values = new Map(
    formatter(timezone)
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")) % 24,
    minute: Number(values.get("minute")),
    weekday: WEEKDAY_NAMES.indexOf(values.get("weekday") ?? ""),
  };
}

function wallKey(value: LocalDate & TimeOfDay): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * The instant a wall-clock time in `timezone` happens. A time inside a
 * daylight-saving gap moves to the next minute that exists (`shifted`); a
 * time that happens twice takes its first occurrence.
 */
export function resolveWallTime(date: LocalDate, time: TimeOfDay, timezone: string): { timestamp: number; shifted: boolean } {
  const nominal = wallKey({ ...date, ...time });
  const offsetAt = (instant: number) => wallKey(localDateTime(instant, timezone)) - instant;
  let guess = nominal - offsetAt(nominal);
  guess = nominal - offsetAt(guess);
  if (wallKey(localDateTime(guess, timezone)) === nominal) {
    for (const earlier of [guess - 60 * MINUTE_MS, guess - 30 * MINUTE_MS]) {
      if (wallKey(localDateTime(earlier, timezone)) === nominal) return { timestamp: earlier, shifted: false };
    }
    return { timestamp: guess, shifted: false };
  }
  // The wall time does not exist: walk forward from just before the gap to the first valid minute.
  let candidate = guess - 3 * 60 * MINUTE_MS;
  const limit = guess + 3 * 60 * MINUTE_MS;
  while (candidate <= limit) {
    const local = localDateTime(candidate, timezone);
    if (wallKey(local) >= nominal) return { timestamp: candidate, shifted: true };
    candidate += MINUTE_MS;
  }
  return { timestamp: guess, shifted: true };
}

// --- Occurrences --------------------------------------------------------------

function windowSlots(schedule: IntervalSchedule): TimeOfDay[] {
  const start = schedule.from ? minutesOf(schedule.from) : 0;
  const end = schedule.until ? minutesOf(schedule.until) : 23 * 60 + 59;
  const slots: TimeOfDay[] = [];
  for (let minutes = start; minutes <= end && slots.length < schedule.maxPerDay; minutes += schedule.everyMinutes) {
    slots.push({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
  }
  return slots;
}

function cronSlots(fields: CronFields, maxPerDay: number): TimeOfDay[] {
  const slots: TimeOfDay[] = [];
  for (const hour of fields.hour.values) {
    for (const minute of fields.minute.values) {
      if (slots.length >= maxPerDay) return slots;
      slots.push({ hour, minute });
    }
  }
  return slots;
}

/** The instants one local day's slots happen, deduplicated and ascending. */
function daySlotInstants(date: LocalDate, slots: TimeOfDay[], timezone: string): number[] {
  const instants = new Set<number>();
  for (const slot of slots) instants.add(resolveWallTime(date, slot, timezone).timestamp);
  return [...instants].sort((left, right) => left - right);
}

function localKindOccurrences(schedule: IntervalSchedule | CronSchedule, after: number, count: number): number[] {
  const fields = schedule.kind === "cron" ? parseCronExpression(schedule.expression) : null;
  const slots = fields ? cronSlots(fields, schedule.maxPerDay) : schedule.kind === "interval" ? windowSlots(schedule) : [];
  if (slots.length === 0) return [];
  // Start one day early: a window slot late in the previous local day can still be ahead of `after`.
  const start = addLocalDays(localDateTime(after, schedule.timezone), -1);
  const occurrences: number[] = [];
  for (let offset = 0; offset < OCCURRENCE_SEARCH_DAYS && occurrences.length < count; offset += 1) {
    const date = addLocalDays(start, offset);
    const weekday = weekdayOf(date);
    if (schedule.kind === "interval") {
      if (schedule.daysOfWeek && !schedule.daysOfWeek.includes(weekday)) continue;
    } else if (fields && !cronMatchesDay(fields, date, weekday)) {
      continue;
    }
    for (const instant of daySlotInstants(date, slots, schedule.timezone)) {
      if (instant > after && (occurrences.length === 0 || instant > (occurrences[occurrences.length - 1] ?? 0))) {
        occurrences.push(instant);
        if (occurrences.length >= count) break;
      }
    }
  }
  return occurrences;
}

/** Up to `count` occurrences strictly after `after`, ascending. */
export function localOccurrences(schedule: LocalSchedule, options: { after: number; count?: number }): number[] {
  const count = Math.max(1, Math.min(options.count ?? 5, 64));
  if (isSharedSchedule(schedule)) {
    const occurrences: number[] = [];
    let after = Math.floor(options.after);
    while (occurrences.length < count) {
      const batch = automationOccurrences(schedule, { after, count: Math.min(5, count - occurrences.length) }).occurrences;
      if (batch.length === 0) break;
      occurrences.push(...batch);
      after = batch[batch.length - 1] ?? after;
    }
    return occurrences;
  }
  return localKindOccurrences(schedule, Math.floor(options.after), count);
}

export function nextLocalOccurrence(schedule: LocalSchedule, after: number): number | null {
  return localOccurrences(schedule, { after, count: 1 })[0] ?? null;
}

// --- Guardrails ---------------------------------------------------------------

export type GuardrailVerdict = { ok: true } | { ok: false; reason: string };

function describeMinutes(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

/**
 * Whether a schedule respects the app's limits for runs on this Mac: the
 * least time between two runs and the most runs one assignment makes a day.
 * The answer is a sentence the coworker can relay as it stands.
 */
export function checkScheduleGuardrails(schedule: LocalSchedule, guardrails: ScheduleGuardrails, now = Date.now()): GuardrailVerdict {
  if (isSharedSchedule(schedule)) return { ok: true };
  if (schedule.maxPerDay > guardrails.maxRunsPerDay) {
    return {
      ok: false,
      reason: `Assignments on this Mac can run at most ${guardrails.maxRunsPerDay === 1 ? "once" : `${guardrails.maxRunsPerDay} times`} a day; this schedule asks for ${schedule.maxPerDay}.`,
    };
  }
  const occurrences = localOccurrences(schedule, { after: now, count: 16 });
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < occurrences.length; index += 1) {
    shortest = Math.min(shortest, (occurrences[index] ?? 0) - (occurrences[index - 1] ?? 0));
  }
  if (Number.isFinite(shortest) && shortest < guardrails.minimumGapMinutes * MINUTE_MS) {
    return {
      ok: false,
      reason: `Runs on this Mac need at least ${describeMinutes(guardrails.minimumGapMinutes)} between them; this schedule would run them ${describeMinutes(Math.round(shortest / MINUTE_MS))} apart.`,
    };
  }
  return { ok: true };
}

/** One day of a schedule, for tests and previews: the local date of `timestamp` in the schedule's zone. */
export function localDayOf(timestamp: number, timezone: string): LocalDate {
  const { year, month, day } = localDateTime(timestamp, timezone);
  return { year, month, day };
}

export { DAY_MS as LOCAL_SCHEDULE_DAY_MS };
