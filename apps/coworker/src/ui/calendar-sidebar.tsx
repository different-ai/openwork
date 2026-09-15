import type { CoworkerSummary } from "@/lib/bridge";
import type { CalendarData } from "@/ui/calendar-data";
import type {
  CalendarPreferences,
  CalendarPreferencesChange,
} from "@/ui/calendar-preferences";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { ActivityIcon } from "@/ui/kit";
import { CalendarIcon } from "@/ui/main-content-switch";

export function CalendarSidebar({
  coworkers,
  data,
  preferences,
  onPreferencesChange,
  query,
}: {
  coworkers: CoworkerSummary[];
  data: CalendarData;
  preferences: CalendarPreferences;
  onPreferencesChange: CalendarPreferencesChange;
  query: string;
}) {
  const slugs = [
    ...new Set([
      ...coworkers.map((member) => member.slug),
      ...data.events.flatMap((event) => event.participantSlugs),
      ...data.eventRuns.flatMap((run) => run.event.participantSlugs),
      ...data.responsibilities.flatMap((item) => item.ownerSlugs),
    ]),
  ];
  const matching = slugs.filter((slug) => {
    const coworker = coworkers.find((member) => member.slug === slug);
    return `${coworker?.name ?? ""} ${coworker?.role ?? ""} ${slug}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });

  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto p-3"
      aria-label="Calendar filters"
      data-testid="calendar-sidebar"
    >
      <header className="mb-4 border-b border-line pb-3">
        <h2 className="text-sm font-semibold text-snow">
          Your team's calendar
        </h2>
        <p className="mt-1 text-[10px] text-mist">Choose whose work appears.</p>
      </header>
      <fieldset
        className="mb-4 space-y-1 border-b border-line pb-4"
        aria-label="Calendar sources"
      >
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-mist">
          Sources
        </legend>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-spark"
            checked={preferences.events}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                events: event.target.checked,
              }))
            }
          />
          <span className="shrink-0 text-spark">
            <CalendarIcon />
          </span>
          Events
        </label>
        <label className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-mint"
            checked={preferences.responsibilities}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                responsibilities: event.target.checked,
              }))
            }
          />
          <span className="shrink-0 text-mint">
            <ActivityIcon />
          </span>
          Responsibilities
        </label>
      </fieldset>
      <fieldset aria-label="Calendar coworkers" className="space-y-1">
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-mist">
          Coworkers
        </legend>
        <label className="flex min-h-9 items-center gap-2 rounded-lg px-1 py-1.5 text-xs font-medium text-snow hover:bg-white/4">
          <input
            type="checkbox"
            className="shrink-0 accent-spark"
            checked={preferences.coworkerSlugs === null}
            onChange={(event) =>
              onPreferencesChange((value) => ({
                ...value,
                coworkerSlugs: event.target.checked ? null : [],
              }))
            }
          />
          <span className="flex size-6 shrink-0 items-center justify-center text-mist">
            <ActivityIcon />
          </span>
          Everyone
        </label>
        {matching.map((slug) => {
          const coworker = coworkers.find((member) => member.slug === slug);
          return (
            <label
              key={slug}
              className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-mist hover:bg-white/4"
            >
              <input
                type="checkbox"
                className="shrink-0 accent-spark"
                checked={
                  preferences.coworkerSlugs === null ||
                  preferences.coworkerSlugs.includes(slug)
                }
                onChange={() =>
                  onPreferencesChange((value) => {
                    const current = value.coworkerSlugs ?? slugs;
                    return {
                      ...value,
                      coworkerSlugs: current.includes(slug)
                        ? current.filter((item) => item !== slug)
                        : [...current, slug],
                    };
                  })
                }
              />
              <span className="flex size-6 shrink-0 items-center justify-center">
                {coworker ? (
                  <CoworkerAvatar
                    identity={coworker.slug}
                    name={coworker.name}
                    color={coworker.avatarColor}
                    glasses={coworker.avatarGlasses}
                    size={24}
                    motion="quiet"
                    animated={false}
                    gaze={false}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-full border border-line text-[10px]"
                  >
                    {slug.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
              <span className="min-w-0 break-words">
                {coworker?.name ?? `${slug} (historical)`}
              </span>
            </label>
          );
        })}
        {matching.length === 0 ? (
          <p className="px-1 py-2 text-xs text-mist">
            {data.loading
              ? "Reading calendars..."
              : query.trim()
                ? "No matching coworkers."
                : "No coworker calendars yet."}
          </p>
        ) : null}
      </fieldset>
    </section>
  );
}
