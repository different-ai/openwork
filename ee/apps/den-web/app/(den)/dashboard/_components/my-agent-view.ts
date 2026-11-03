import type {
  AgentChangeField,
  AgentCheckOutcome,
  MemberAgentChange,
  MemberAgentView,
} from "@openwork/types/den/workbot-proactive";
import type { DenBadgeTone } from "../../_components/ui/badge";

/**
 * My agent's words, kept pure so the Library row and page can be tested without a browser. Times are shown in the
 * member's calendar time zone (the agent's), which is what its hours and sentences use.
 */

function dayKey(at: number, timeZone: string | undefined) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function clockLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
}

/** "at 11:20 AM", "yesterday at 7:05 PM", "on Mon at 9:02 AM". */
export function whenPhrase(iso: string, timeZone: string | undefined, now: number): string {
  const at = Date.parse(iso);
  const clock = clockLabel(iso, timeZone);
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return `at ${clock}`;
  if (dayKey(at, timeZone) === dayKey(now - 86_400_000, timeZone)) return `yesterday at ${clock}`;
  if (dayKey(at, timeZone) === dayKey(now + 86_400_000, timeZone)) return `tomorrow at ${clock}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return `on ${weekday} at ${clock}`;
}

/** "Mon 9:02 AM", for the week's list. */
export function dayClockLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
}

export function isSameDay(iso: string, now: number, timeZone?: string) {
  return dayKey(Date.parse(iso), timeZone) === dayKey(now, timeZone);
}

/** Where the agent stands, in one line, for the Library row. */
export function myAgentStateLine(view: MemberAgentView, now: number): string {
  const timeZone = view.timeZone;
  if (!view.available) return "Turned off by your admin.";
  if (!view.on) return "Off.";
  if (view.snoozedUntil) return `Snoozed until ${clockLabel(view.snoozedUntil, timeZone)}.`;
  if (view.lastCheck) return `Last check ${whenPhrase(view.lastCheck.at, timeZone, now)}. ${view.lastCheck.headline}.`;
  if (view.nextCheckAt) return `No checks yet. First check ${whenPhrase(view.nextCheckAt, timeZone, now)}.`;
  return "No checks yet.";
}

/** "1 of 3 today". */
export function sentTodayLabel(view: MemberAgentView): string | null {
  if (view.sentToday === undefined || !view.limits) return null;
  return `${view.sentToday} of ${view.limits.dailyCap} today`;
}

export const OUTCOME_PILL: Record<AgentCheckOutcome, { label: string; tone: DenBadgeTone }> = {
  sent: { label: "Sent", tone: "info" },
  quiet: { label: "Quiet", tone: "neutral" },
  waited: { label: "Waited", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

/** The change behind a field's current value, when the member made one: what "Saved from chat at …" refers to. */
export function latestChange(view: MemberAgentView, field: AgentChangeField): MemberAgentChange | null {
  return (view.changes ?? []).find((change) => change.field === field && !change.undone) ?? null;
}

/** "Saved from chat at 11:20 AM.", "Saved here yesterday at 4:00 PM." */
export function changeSourceLine(change: MemberAgentChange, timeZone: string | undefined, now: number): string {
  return `Saved ${change.source === "chat" ? "from chat" : "here"} ${whenPhrase(change.at, timeZone, now)}.`;
}

export function hourLabel(hour: number): string {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

export function hoursLabel(hours: { startHour: number; endHour: number }): string {
  return `${hourLabel(hours.startHour)}–${hourLabel(hours.endHour)}`;
}
