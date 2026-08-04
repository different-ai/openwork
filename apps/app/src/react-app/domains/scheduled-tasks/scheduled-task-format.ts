const SUNDAY_UTC = Date.UTC(2024, 0, 7);

export function formatScheduledTaskWeekdays(daysOfWeek: number[], locales?: Intl.LocalesArgument) {
  const formatter = new Intl.DateTimeFormat(locales, {
    weekday: "short",
    timeZone: "UTC",
  });

  return daysOfWeek
    .map((day) => formatter.format(new Date(SUNDAY_UTC + day * 24 * 60 * 60 * 1_000)))
    .join(", ");
}
