import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";

const preferencesSchema = z.object({
  view: z
    .enum(["day", "week", "month", "agenda"])
    .transform((view) => (view === "agenda" ? "week" : view)),
  coworkerSlugs: z.array(z.string()).nullable(),
  events: z.boolean(),
  responsibilities: z.boolean(),
});
const PREFERENCES_KEY = "coworker.calendar.preferences.v1";

export type CalendarPreferences = z.infer<typeof preferencesSchema>;
export type CalendarPreferencesChange = Dispatch<
  SetStateAction<CalendarPreferences>
>;

/** App owns this once; the rail and calendar receive the same controlled preferences. */
export function useCalendarPreferences(): [
  CalendarPreferences,
  CalendarPreferencesChange,
] {
  const [preferences, setPreferences] = useState<CalendarPreferences>(() => {
    try {
      const parsed = preferencesSchema.safeParse(
        JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? "null"),
      );
      if (parsed.success) return parsed.data;
    } catch {
      // Defaults work without a preference store.
    }
    return {
      view: "week",
      coworkerSlugs: null,
      events: true,
      responsibilities: true,
    };
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Keep session preferences when storage is unavailable.
    }
  }, [preferences]);
  return [preferences, setPreferences];
}
