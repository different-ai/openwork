const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

export function initials(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`).toUpperCase();
}
