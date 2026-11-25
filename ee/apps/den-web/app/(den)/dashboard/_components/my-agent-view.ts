import type {
  AgentChangeField,
  AgentCheckOutcome,
  MemberAgentChange,
  MemberAgentView,
} from "@openwork/types/den/workbot-proactive";
import type { DenBadgeTone } from "../../_components/ui/badge";

function dayKey(at: number, timeZone: string | undefined) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function clockLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
}

export function whenPhrase(iso: string, timeZone: string | undefined, now: number): string {
  const at = Date.parse(iso);
  const clock = clockLabel(iso, timeZone);
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return `at ${clock}`;
  if (dayKey(at, timeZone) === dayKey(now - 86_400_000, timeZone)) return `yesterday at ${clock}`;
  if (dayKey(at, timeZone) === dayKey(now + 86_400_000, timeZone)) return `tomorrow at ${clock}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return `on ${weekday} at ${clock}`;
}

export function dayClockLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(Date.parse(iso));
}

export function isSameDay(iso: string, now: number, timeZone?: string) {
  return dayKey(Date.parse(iso), timeZone) === dayKey(now, timeZone);
}

export function myAgentStateLine(view: MemberAgentView, now: number): string {
  const timeZone = view.timeZone;
  if (!view.available) return "Turned off by your admin.";
  if (!view.on) return "Off.";
  if (view.snoozedUntil) return `Snoozed until ${clockLabel(view.snoozedUntil, timeZone)}.`;
  if (view.lastCheck) return `Last check ${whenPhrase(view.lastCheck.at, timeZone, now)}. ${view.lastCheck.headline}.`;
  if (view.nextCheckAt) return `No checks yet. First check ${whenPhrase(view.nextCheckAt, timeZone, now)}.`;
  return "No checks yet.";
}

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

export function latestChange(view: MemberAgentView, field: AgentChangeField): MemberAgentChange | null {
  return (view.changes ?? []).find((change) => change.field === field && !change.undone) ?? null;
}

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

export function nextChecksLine(view: MemberAgentView, now: number): string | null {
  const [next, then] = view.nextChecks ?? [];
  if (!next) return null;
  const when = (iso: string) => (isSameDay(iso, now, view.timeZone) ? clockLabel(iso, view.timeZone) : whenPhrase(iso, view.timeZone, now));
  const first = `Next check ${when(next.at)}${next.why ? `: ${next.why}` : ""}.`;
  return then ? `${first} Then ${when(then.at)}${then.why ? `: ${then.why}` : ""}.` : first;
}

export function everyHoursLabel(hours: number): string {
  return hours === 1 ? "Every hour" : `Every ${hours} hours`;
}
