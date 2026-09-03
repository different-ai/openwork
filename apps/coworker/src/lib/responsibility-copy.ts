/**
 * The words a responsibility uses when it talks to a person. Everything here
 * is pure so the copy is unit-tested once and the rows only render what these
 * return: no time-zone identifiers, no slots, no threads, no status codes.
 */
import { parseCronExpression } from "./local-schedule.ts";
import type { CronFields, CronSchedule, IntervalSchedule, LocalSchedule, TimeOfDay } from "./local-schedule.ts";
import type { RunEntry, RunOutcome } from "./run-history.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SET = [1, 2, 3, 4, 5];

export type ClockOptions = {
  /** The person's own time zone; a schedule in another zone says so. */
  localZone?: string;
  /** Fixed clock for tests. */
  now?: number;
  locale?: string;
};

function localZoneOf(options: ClockOptions): string {
  return options.localZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "9:00 AM" from a 24-hour schedule time. */
export function formatClockTime(hour: number, minute: number, locale?: string): string {
  const date = new Date(2000, 0, 1, hour, minute);
  return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** "(Los Angeles time)" when a schedule keeps a different clock than the person; empty otherwise. */
export function describeZone(timezone: string, options: ClockOptions = {}): string {
  const zone = timezone.trim();
  if (!zone || zone === localZoneOf(options)) return "";
  if (/^(UTC|GMT|Etc\/UTC|Etc\/GMT)$/i.test(zone)) return "(UTC)";
  const city = zone.split("/").pop() ?? zone;
  return `(${city.replaceAll("_", " ")} time)`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** "day", "weekday", or "Monday and Thursday" for a set of weekdays; empty when it means every day. */
function describeDays(daysOfWeek: readonly number[] | undefined): string {
  const days = [...new Set(daysOfWeek ?? [])].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return "";
  if (days.length === 5 && WEEKDAY_SET.every((day) => days.includes(day))) return "weekday";
  return joinNames(days.map((day) => WEEKDAYS[day] ?? `day ${day}`));
}

/** "Every 2 hours", "Every hour", "Every 12 hours". */
function describeEvery(minutes: number): string {
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** ", up to 4 times a day" / ", once a day". */
function describeCap(maxPerDay: number): string {
  return maxPerDay === 1 ? ", once a day" : `, up to ${maxPerDay} times a day`;
}

function describeWindow(from: TimeOfDay | undefined, until: TimeOfDay | undefined, locale?: string): string {
  const start = from ? formatClockTime(from.hour, from.minute, locale) : "";
  const end = until ? formatClockTime(until.hour, until.minute, locale) : "";
  if (start && end) return ` between ${start} and ${end}`;
  if (start) return ` from ${start}`;
  if (end) return ` until ${end}`;
  return "";
}

/** "Every 2 hours between 9:00 AM and 6:00 PM on weekdays, up to 4 times a day". */
function describeInterval(schedule: IntervalSchedule, options: ClockOptions): string {
  const days = describeDays(schedule.daysOfWeek);
  const dayText = days ? (days === "weekday" ? " on weekdays" : ` on ${days}`) : "";
  const zone = describeZone(schedule.timezone, options);
  return `${describeEvery(schedule.everyMinutes)}${describeWindow(schedule.from, schedule.until, options.locale)}${dayText}${describeCap(schedule.maxPerDay)}${zone ? ` ${zone}` : ""}`;
}

/**
 * The everyday reading of a custom timetable when it has one: one time on
 * some days ("Every weekday at 9:00 AM"), or a stepped hour ("Every 2 hours
 * between 9:00 AM and 6:00 PM on weekdays"). Null when only the expression
 * says it.
 */
export function cronPlainReading(fields: CronFields, options: ClockOptions = {}): string | null {
  if (!fields.dayOfMonth.any || !fields.month.any) return null;
  const minute = fields.minute.values.length === 1 ? fields.minute.values[0] : undefined;
  if (minute === undefined) return null;
  const days = fields.dayOfWeek.any ? "" : describeDays(fields.dayOfWeek.values);
  if (fields.hour.values.length === 1) {
    const hour = fields.hour.values[0] ?? 0;
    const time = formatClockTime(hour, minute, options.locale);
    return `Every ${days || "day"} at ${time}`;
  }
  if (fields.hour.step && fields.hour.range) {
    const [start, end] = fields.hour.range;
    const wholeDay = start === 0 && end === 23;
    const window = wholeDay ? "" : describeWindow({ hour: start, minute }, { hour: end, minute }, options.locale);
    const dayText = days ? (days === "weekday" ? " on weekdays" : ` on ${days}`) : "";
    return `${describeEvery(fields.hour.step * 60)}${window}${dayText}`;
  }
  return null;
}

function describeCron(schedule: CronSchedule, options: ClockOptions): string {
  const zone = describeZone(schedule.timezone, options);
  let reading: string | null = null;
  try {
    reading = cronPlainReading(parseCronExpression(schedule.expression), options);
  } catch {
    reading = null;
  }
  const base = reading ?? "On a custom timetable";
  return `${base}${describeCap(schedule.maxPerDay)}${zone ? ` ${zone}` : ""}`;
}

/**
 * "Every day at 9:00 AM", "Every Monday and Thursday at 9:00 AM (Paris time)",
 * "Every weekday at 8:30 AM", "Once, on Sep 5 at 9:00 AM",
 * "Every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a day",
 * "On a custom timetable, up to 4 times a day".
 */
export function describeScheduleForPeople(schedule: LocalSchedule, options: ClockOptions = {}): string {
  if (schedule.kind === "once") {
    return `Once, ${describeMoment(schedule.at, options)}`;
  }
  if (schedule.kind === "interval") return describeInterval(schedule, options);
  if (schedule.kind === "cron") return describeCron(schedule, options);
  const time = formatClockTime(schedule.hour, schedule.minute, options.locale);
  const zone = describeZone(schedule.timezone, options);
  const suffix = zone ? ` ${zone}` : "";
  if (schedule.kind === "daily") {
    return `Every day at ${time}${suffix}`;
  }
  return `Every ${describeDays(schedule.daysOfWeek) || "day"} at ${time}${suffix}`;
}

/** The schedule as a phrase inside a sentence: "every 2 hours between 9:00 AM and 6:00 PM, up to 4 times a day". */
export function describeScheduleInSentence(schedule: LocalSchedule, options: ClockOptions = {}): string {
  const text = describeScheduleForPeople(schedule, options);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "today at 12:05 PM", "tomorrow at 9:00 AM", "yesterday at 3:10 PM", "Sep 5 at 9:00 AM". */
export function describeMoment(timestamp: number | null | undefined, options: ClockOptions = {}): string {
  if (!timestamp) return "";
  const now = options.now ?? Date.now();
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(options.locale, { hour: "numeric", minute: "2-digit" });
  const dayDelta = Math.round((startOfDay(timestamp) - startOfDay(now)) / 86_400_000);
  if (dayDelta === 0) return `today at ${time}`;
  if (dayDelta === 1) return `tomorrow at ${time}`;
  if (dayDelta === -1) return `yesterday at ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = date.toLocaleDateString(options.locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${day} at ${time}`;
}

/** Capitalise a moment when it starts a sentence: "Today at 12:05 PM". */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "7 seconds", "1 minute", "2 minutes", "1 hour 5 minutes". */
export function describeDurationForPeople(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest ? `${hourText} ${rest} minute${rest === 1 ? "" : "s"}` : hourText;
}

/** The outcome as a plain past-tense phrase for a message to the coworker: "It succeeded." */
export function outcomeForPrompt(outcome: RunOutcome): string {
  switch (outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "missed":
      return "was missed";
    case "cancelled":
      return "was cancelled";
    case "running":
      return "is still running";
    default:
      return "is waiting its turn";
  }
}

/** Counts a person can read at a glance: "Ran once · done", "Ran 5 times · 4 done · 1 didn't finish". */
export function describeRunTrend(entries: ReadonlyArray<Pick<RunEntry, "outcome">>): string {
  const finished = entries.filter((entry) => entry.outcome !== "queued" && entry.outcome !== "running");
  if (finished.length === 0) return "";
  const done = finished.filter((entry) => entry.outcome === "succeeded").length;
  const unfinished = finished.filter((entry) => entry.outcome === "failed").length;
  const missed = finished.filter((entry) => entry.outcome === "missed").length;
  const parts = [finished.length === 1 ? "Ran once" : finished.length === 2 ? "Ran twice" : `Ran ${finished.length} times`];
  if (finished.length === 1) {
    if (done) parts.push("done");
    else if (unfinished) parts.push("didn't finish");
    else if (missed) parts.push("missed");
    else parts.push("cancelled");
    return parts.join(" · ");
  }
  if (done) parts.push(`${done} done`);
  if (unfinished) parts.push(`${unfinished} didn't finish`);
  if (missed) parts.push(`${missed} missed`);
  return parts.join(" · ");
}

export type RowStatusInput = {
  /** Newest run, whatever its state. */
  latest: Pick<RunEntry, "outcome" | "at"> | undefined;
  /** Newest run that actually finished. */
  finished: Pick<RunEntry, "outcome" | "at"> | undefined;
  paused: boolean;
  needsAttention: boolean;
  nextDueAt: number | null;
};

/**
 * The second half of a row's one line, after the schedule:
 * "Working on it now", "Waiting its turn", "Needs you", "Paused",
 * "Done today at 12:05 PM", "Didn't finish yesterday at 9:00 AM", "Next: tomorrow at 9:00 AM".
 */
export function describeRowStatus(input: RowStatusInput, options: ClockOptions = {}): string {
  if (input.latest?.outcome === "running") return "Working on it now";
  if (input.latest?.outcome === "queued") return "Waiting its turn";
  if (input.needsAttention) return "Needs you";
  if (input.paused) return "Paused";
  if (input.finished) {
    const word = input.finished.outcome === "succeeded"
      ? "Done"
      : input.finished.outcome === "failed"
        ? "Didn't finish"
        : input.finished.outcome === "missed"
          ? "Missed"
          : "Cancelled";
    const when = describeMoment(input.finished.at, options);
    return when ? `${word} ${when}` : word;
  }
  const next = describeMoment(input.nextDueAt, options);
  return next ? `Next: ${next}` : "Not scheduled";
}

/** Where a responsibility runs, as a sentence a person can act on. */
export function describeWhere(placement: "local" | "cloud" | "desktop"): string {
  if (placement === "cloud") return "In OpenWork Cloud — even when this Mac is off";
  if (placement === "desktop") return "In the OpenWork desktop app, when it is open for your account";
  return "On this Mac — only while Open Coworker is open";
}
