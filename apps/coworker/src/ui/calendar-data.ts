import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { createDenAutomationsClient, type DenSession } from "@/lib/den";
import type { EventRun, WorkplaceEvent } from "@/lib/events";
import {
  cloudCalendarResponsibility,
  localCalendarResponsibility,
  type CalendarResponsibility,
} from "@/lib/calendar";

type Snapshot = {
  events: WorkplaceEvent[];
  eventRuns: EventRun[];
  responsibilities: CalendarResponsibility[];
  errors: string[];
};
const empty = (): Snapshot => ({
  events: [],
  eventRuns: [],
  responsibilities: [],
  errors: [],
});

export function useCalendarData(
  coworkers: CoworkerSummary[],
  session: DenSession | null,
  enabled: boolean,
) {
  const [data, setData] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const teamRef = useRef(coworkers);
  teamRef.current = coworkers;
  const teamKey = JSON.stringify(
    coworkers.map((member) => [
      member.slug,
      member.createdAt,
      member.workspaceId,
      member.automations,
    ]),
  );
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let cancelled = false;
    let reading: Promise<void> | null = null;
    let again = false;
    let previous = empty();
    setData(previous);
    setLoading(true);
    if (!enabled) {
      refreshRef.current = async () => {};
      return;
    }
    const team = teamRef.current;
    const den = session ? createDenAutomationsClient(session) : null;
    // Bound simultaneous native/Cloud reads, including when the event archive grows.
    async function batches<T, R>(
      items: T[],
      read: (item: T) => Promise<R>,
    ): Promise<R[]> {
      const result: R[] = [];
      for (let offset = 0; offset < items.length && !cancelled; offset += 6)
        result.push(
          ...(await Promise.all(items.slice(offset, offset + 6).map(read))),
        );
      return result;
    }
    const load = (): Promise<void> => {
      if (reading) {
        again = true;
        return reading;
      }
      reading = (async () => {
        do {
          again = false;
          if (cancelled) return;
          setRefreshing(true);
          const errors: string[] = [];
          const [eventData, local, cloud] = await Promise.all([
            (async () => {
              try {
                const events = await coworkerBridge.events.list();
                const details = await batches(events, async (event) => {
                  try {
                    return await coworkerBridge.events.get(event.id);
                  } catch {
                    errors.push(
                      `History for ${event.title} is unavailable; any previous snapshot is kept.`,
                    );
                    return {
                      event,
                      runs: previous.eventRuns.filter(
                        (run) => run.eventId === event.id,
                      ),
                    };
                  }
                });
                return {
                  events: details.map((detail) => detail.event),
                  eventRuns: details.flatMap((detail) => detail.runs),
                };
              } catch (cause) {
                errors.push(
                  `Events could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
                return {
                  events: previous.events,
                  eventRuns: previous.eventRuns,
                };
              }
            })(),
            batches(team, async (member) => {
              try {
                return (
                  await coworkerBridge.localResponsibilities.list(member.slug)
                ).map((item) => localCalendarResponsibility(member.slug, item));
              } catch {
                errors.push(
                  `Schedules for ${member.name} are unavailable; any previous snapshot may be stale.`,
                );
                return previous.responsibilities.filter(
                  (item) =>
                    item.placement === "local" &&
                    item.ownerSlugs.includes(member.slug),
                );
              }
            }).then((items) => items.flat()),
            (async () => {
              if (!den) return [];
              try {
                const list = await den.list();
                if (list.items.length >= 50)
                  errors.push(
                    "Cloud currently returns the first 50 assignments; this calendar may not include the rest.",
                  );
                return await batches(list.items, async (entry) => {
                  try {
                    return cloudCalendarResponsibility(
                      entry,
                      team,
                      await den.listRuns(entry.automation.id),
                    );
                  } catch {
                    errors.push(
                      `Run history for ${entry.automation.name} is unavailable; any previous snapshot is kept.`,
                    );
                    const item = cloudCalendarResponsibility(entry, team, []);
                    return {
                      ...item,
                      runs:
                        previous.responsibilities.find(
                          (known) =>
                            known.id === item.id &&
                            known.placement === item.placement,
                        )?.runs ?? [],
                    };
                  }
                });
              } catch (cause) {
                errors.push(
                  `Cloud schedules could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
                return previous.responsibilities.filter(
                  (item) => item.placement !== "local",
                );
              }
            })(),
          ]);
          if (cancelled) return;
          previous = {
            ...eventData,
            responsibilities: [...local, ...cloud],
            errors,
          };
          setData(previous);
          setLoading(false);
          setRefreshing(false);
        } while (again && !cancelled);
      })().finally(() => {
        reading = null;
      });
      return reading;
    };
    refreshRef.current = load;
    void load();
    const timer = window.setInterval(() => {
      if (!reading) void load();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (refreshRef.current === load) refreshRef.current = async () => {};
    };
  }, [enabled, session, teamKey]);
  return { ...data, loading, refreshing, refresh };
}

export type CalendarData = ReturnType<typeof useCalendarData>;
