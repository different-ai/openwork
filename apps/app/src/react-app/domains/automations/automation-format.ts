import type { AutomationSchedule } from "@openwork/types/automations";

const SUNDAY_UTC = Date.UTC(2024, 0, 7);

export function formatAutomationWeekdays(daysOfWeek: number[], locales?: Intl.LocalesArgument) {
  const formatter = new Intl.DateTimeFormat(locales, {
    weekday: "short",
    timeZone: "UTC",
  });

  return daysOfWeek
    .map((day) => formatter.format(new Date(SUNDAY_UTC + day * 24 * 60 * 60 * 1_000)))
    .join(", ");
}

export function formatAutomationTime(value: number | null | undefined) {
  return typeof value === "number" ? new Date(value).toLocaleString() : "—";
}

export function formatAutomationSchedule(schedule: AutomationSchedule) {
  if (schedule.kind === "once") {
    return `Once · ${formatAutomationTime(schedule.at)} · ${schedule.timezone}`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.kind === "daily") return `Daily · ${time} · ${schedule.timezone}`;
  return `Weekly · ${formatAutomationWeekdays(schedule.daysOfWeek)} · ${time} · ${schedule.timezone}`;
}
