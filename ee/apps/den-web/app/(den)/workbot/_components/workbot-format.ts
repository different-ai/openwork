import type { WorkbotSchedule } from "./workbot-data";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number) {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "Every Monday at 8:00 AM", in the words a person would use. */
export function scheduleLabel(schedule: WorkbotSchedule) {
  if (schedule.kind === "once") {
    return new Date(schedule.at).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: schedule.timezone,
    });
  }
  const at = clock(schedule.hour, schedule.minute);
  if (schedule.kind === "daily") return `Every day at ${at}`;
  const days = [...schedule.daysOfWeek].sort((left, right) => left - right);
  if (days.length === 7) return `Every day at ${at}`;
  if (days.join() === "1,2,3,4,5") return `Every weekday at ${at}`;
  if (days.length === 1) return `Every ${WEEKDAYS[days[0]] ?? "week"} at ${at}`;
  const names = days.map((day) => `${WEEKDAYS[day] ?? ""}s`);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} at ${at}`;
}

export function nextRunLabel(at: number | null) {
  if (at === null) return null;
  return `Next ${new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
}

export function durationLabel(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function timeLabel(at: number) {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function startOfDay(at: number) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Today", "Yesterday", "Friday", or "Sep 12" for older days. */
export function dayLabel(at: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[new Date(at).getDay()] ?? "Earlier";
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "drafts/launch-pricing-copy.md" → "Launch pricing copy". */
export function fileTitle(path: string) {
  const name = path.split("/").pop() ?? path;
  const words = name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

export function initials(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`).toUpperCase();
}
