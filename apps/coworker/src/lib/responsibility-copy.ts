/**
 * The words a responsibility uses when it talks to a person. Everything here
 * is pure so the copy is unit-tested once and the rows only render what these
 * return: no time-zone identifiers, no slots, no threads, no status codes.
 */
import type { AutomationSchedule } from "@openwork/types/automations";
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

/**
 * "Every day at 9:00 AM", "Every Monday and Thursday at 9:00 AM (Paris time)",
 * "Every weekday at 8:30 AM", "Once, on Sep 5 at 9:00 AM".
 */
export function describeScheduleForPeople(schedule: AutomationSchedule, options: ClockOptions = {}): string {
  if (schedule.kind === "once") {
    return `Once, ${describeMoment(schedule.at, options)}`;
  }
  const time = formatClockTime(schedule.hour, schedule.minute, options.locale);
  const zone = describeZone(schedule.timezone, options);
  const suffix = zone ? ` ${zone}` : "";
  if (schedule.kind === "daily") {
    return `Every day at ${time}${suffix}`;
  }
  const days = [...new Set(schedule.daysOfWeek)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
  const label = days.length === 7
    ? "day"
    : days.length === 5 && WEEKDAY_SET.every((day) => days.includes(day))
      ? "weekday"
      : joinNames(days.map((day) => WEEKDAYS[day] ?? `day ${day}`));
  return `Every ${label} at ${time}${suffix}`;
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
