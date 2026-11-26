import type { AutomationRunReceipt, AutomationSchedule } from "@openwork/types/automations";

import { t } from "@/i18n";

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

function sameDays(days: readonly number[], expected: readonly number[]) {
  return days.length === expected.length && expected.every((day) => days.includes(day));
}

function clock(hour: number, minute = 0): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", ...(minute ? { minute: "2-digit" } : {}), timeZone: "UTC" })
    .format(new Date(Date.UTC(2024, 0, 1, hour % 24, minute)));
}

function dayNames(days: readonly number[]): string {
  if (sameDays(days, WEEKDAYS)) return t("agents.schedule_weekdays");
  if (sameDays(days, WEEKEND)) return t("agents.schedule_weekends");
  if (days.length === 7) return t("agents.schedule_every_day");
  const format = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
  return [...days].sort((a, b) => a - b).map((day) => format.format(new Date(Date.UTC(2024, 0, 7 + day)))).join(", ");
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/, 1)[0] ?? "";
}

export function scheduleInWords(schedule: AutomationSchedule): string {
  if (schedule.kind === "interval") {
    const parts = [schedule.everyHours === 1 ? t("agents.schedule_every_hour") : t("agents.schedule_every_hours", { count: schedule.everyHours })];
    if (schedule.startHour !== 0 || schedule.endHour !== 24) {
      parts.push(t("agents.schedule_window", { from: clock(schedule.startHour), to: clock(schedule.endHour) }));
    }
    if (schedule.daysOfWeek.length < 7) parts.push(dayNames(schedule.daysOfWeek));
    return parts.join(", ");
  }
  if (schedule.kind === "daily") return t("agents.schedule_daily", { time: clock(schedule.hour, schedule.minute) });
  if (schedule.kind === "weekly") {
    return t("agents.schedule_weekly", { days: capitalized(dayNames(schedule.daysOfWeek)), time: clock(schedule.hour, schedule.minute) });
  }
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return t("agents.schedule_once", {
      date: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: schedule.timezone }).format(at),
      time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: schedule.timezone }).format(at),
    });
  }
  return t("agents.schedule_meetings");
}

export function scheduleZone(schedule: AutomationSchedule): string | null {
  if (schedule.timezone === new Intl.DateTimeFormat().resolvedOptions().timeZone) return null;
  const zone = new Intl.DateTimeFormat(undefined, { timeZone: schedule.timezone, timeZoneName: "shortGeneric" })
    .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
  return zone ?? schedule.timezone;
}

export function timeOfDay(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

export function whenInWords(timestamp: number, now: number): string {
  const time = timeOfDay(timestamp);
  const day = (value: number) => new Date(value).toDateString();
  if (day(timestamp) === day(now)) return t("agents.when_today", { time });
  if (day(timestamp) === day(now + 24 * 60 * 60 * 1_000)) return t("agents.when_tomorrow", { time });
  return t("agents.when_date", { date: new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(timestamp)), time });
}

export function runStepCount(receipt: Pick<AutomationRunReceipt, "events">): number {
  return receipt.events.filter((event) => event.type === "capability_execution").length;
}
