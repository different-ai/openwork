const WEEKDAY_NUMBERS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function withNumberedWeekdays(rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object" || !("routine" in rawArgs)) return rawArgs;
  const routine = rawArgs.routine;
  if (!routine || typeof routine !== "object" || !("schedule" in routine)) return rawArgs;
  const schedule = routine.schedule;
  if (!schedule || typeof schedule !== "object") return rawArgs;
  const named = "daysOfWeek" in schedule ? schedule.daysOfWeek : "days" in schedule ? schedule.days : undefined;
  if (!Array.isArray(named)) return rawArgs;
  const { days: _days, ...rest } = { days: undefined, ...schedule };
  const daysOfWeek = named.map((day: unknown) => typeof day === "string" ? WEEKDAY_NUMBERS[day.trim().slice(0, 3).toLowerCase()] ?? day : day);
  return { ...rawArgs, routine: { ...routine, schedule: { ...rest, daysOfWeek } } };
}
