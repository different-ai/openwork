export type OpenworkRuntimeFacts = {
  timeZone: string;
  utcOffset: string;
  localDate: string;
  weekday: string;
  locale: string;
};

export type OpenworkRuntimeFactsInput = {
  now?: Date;
  timeZone?: string;
  locale?: string;
};

const FALLBACK_TIME_ZONE = "UTC";
const FALLBACK_LOCALE = "en-US";

function detectTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.trim().length > 0 ? zone : FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

function detectLocale(): string {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language.trim()) {
    return navigator.language;
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale && locale.trim().length > 0 ? locale : FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((entry) => entry.type === type)?.value ?? "";
}

function formatOffset(minutesEastOfUtc: number): string {
  const sign = minutesEastOfUtc < 0 ? "-" : "+";
  const total = Math.abs(minutesEastOfUtc);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function offsetFor(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const asUtc = Date.UTC(
    Number(part(parts, "year")),
    Number(part(parts, "month")) - 1,
    Number(part(parts, "day")),
    Number(part(parts, "hour")),
    Number(part(parts, "minute")),
    Number(part(parts, "second")),
  );
  const wholeSeconds = now.getTime() - (now.getTime() % 1000);
  return formatOffset(Math.round((asUtc - wholeSeconds) / 60_000));
}

export function readOpenworkRuntimeFacts(input: OpenworkRuntimeFactsInput = {}): OpenworkRuntimeFacts {
  const now = input.now ?? new Date();
  const locale = input.locale ?? detectLocale();
  let timeZone = input.timeZone ?? detectTimeZone();
  let dateParts: Intl.DateTimeFormatPart[];
  try {
    dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(now);
  } catch {
    timeZone = FALLBACK_TIME_ZONE;
    dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(now);
  }
  return {
    timeZone,
    utcOffset: offsetFor(timeZone, now),
    localDate: `${part(dateParts, "year")}-${part(dateParts, "month")}-${part(dateParts, "day")}`,
    weekday: part(dateParts, "weekday"),
    locale,
  };
}

export function renderOpenworkRuntimeContext(facts: OpenworkRuntimeFacts): string {
  return [
    "User context:",
    `- Time zone: ${facts.timeZone} (${facts.utcOffset})`,
    `- Today's date in that time zone: ${facts.weekday} ${facts.localDate}`,
    `- Locale: ${facts.locale}`,
    "Resolve \"today\", \"tomorrow\", \"this week\", and other relative dates and times in this time zone, even when another date or clock in this prompt or on the host differs. For the exact current time, read the system clock and convert it to this time zone.",
  ].join("\n");
}
