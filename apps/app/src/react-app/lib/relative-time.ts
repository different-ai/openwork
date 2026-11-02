/**
 * Relative dates for project cards and session rows, Claude-style:
 * "hace 5 días" for fresh activity, "21 oct" once it ages out.
 */
export function relativeTime(timestamp: number | null | undefined, now: number): string {
  if (!timestamp || timestamp <= 0) return "";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "ahora mismo";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 3600) return formatter.format(-Math.round(seconds / 60), "minute");
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return formatter.format(-days, "day");
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(timestamp));
}

/** First-letter-updated variant for list rows ("Hace 2 horas"). */
export function sentenceTime(timestamp: number | null | undefined, now: number): string {
  const label = relativeTime(timestamp, now);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}
