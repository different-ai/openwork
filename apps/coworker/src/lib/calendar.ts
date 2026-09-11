import type {
  AutomationList,
  AutomationRun,
} from "@openwork/types/automations";
import type { CoworkerSummary, LocalResponsibility } from "./bridge";
import type { EventRun, WorkplaceEvent } from "./events";
import { localOccurrences, type LocalSchedule } from "./local-schedule.ts";

export type CalendarResponsibility = {
  id: string;
  name: string;
  instructions: string;
  ownerSlugs: string[];
  schedule: LocalSchedule;
  state: string;
  nextDueAt: number | null;
  createdAt: number;
  placement: "local" | "cloud" | "desktop";
  runs: Array<{
    id: string;
    status: string;
    at: number;
    finishedAt: number | null;
    scheduledFor: number | null;
    threadId: string;
    summary: string;
  }>;
};

export type CalendarItem = {
  id: string;
  kind: "event" | "responsibility";
  title: string;
  startsAt: number;
  endsAt: number | null;
  coworkerSlugs: string[];
  status: string;
  planned: boolean;
  placement: "local" | "cloud" | "desktop";
  eventId?: string;
  eventRunId?: string;
  responsibilityId?: string;
  ownerSlug?: string;
  threadId?: string;
  summary?: string;
};

export function localCalendarResponsibility(
  slug: string,
  item: LocalResponsibility,
): CalendarResponsibility {
  return {
    id: item.id,
    name: item.name,
    instructions: item.instructions,
    ownerSlugs: [slug],
    schedule: item.schedule,
    state: item.state,
    nextDueAt: item.nextDueAt,
    createdAt: item.createdAt,
    placement: "local",
    runs: item.runs.map((run) => ({
      id: run.id,
      status: run.status,
      at: run.queuedAt ?? run.startedAt,
      finishedAt: run.finishedAt,
      scheduledFor: null,
      threadId: run.threadId,
      summary: run.error || run.summary,
    })),
  };
}

export function cloudCalendarResponsibility(
  { automation, revision, latestRun }: AutomationList["items"][number],
  coworkers: CoworkerSummary[],
  runs: AutomationRun[],
): CalendarResponsibility {
  const history = new Map(runs.map((run) => [run.id, run]));
  if (latestRun && !history.has(latestRun.id))
    history.set(latestRun.id, latestRun);
  return {
    id: automation.id,
    name: automation.name,
    instructions: revision.instructions,
    ownerSlugs: coworkers
      .filter(
        (coworker) =>
          coworker.automations.includes(automation.id) ||
          (Boolean(coworker.workspaceId) &&
            coworker.workspaceId === revision.workspaceId),
      )
      .map((coworker) => coworker.slug),
    schedule: revision.schedule,
    state: automation.state,
    nextDueAt: automation.nextDueAt,
    createdAt: automation.createdAt,
    // Legacy definitions were created by the OpenWork desktop surface, not Cloud.
    placement: revision.executionTarget ?? "desktop",
    runs: [...history.values()].map((run) => ({
      id: run.id,
      status: run.status,
      at: run.startedAt ?? run.createdAt,
      finishedAt: run.finishedAt,
      scheduledFor: run.scheduledFor,
      // A Cloud/OpenWork desktop thread is not a local Coworker discussion.
      threadId: "",
      summary: run.error?.message || run.resultSummary || "",
    })),
  };
}

/** Read-only projection. No occurrence claim, mutation, inferred past run, or second scheduler. */
export function calendarItems({
  events,
  eventRuns,
  responsibilities,
  start,
  end,
  now,
}: {
  events: WorkplaceEvent[];
  eventRuns: EventRun[];
  responsibilities: CalendarResponsibility[];
  start: number;
  end: number;
  now: number;
}): CalendarItem[] {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 62 * 86400000
  )
    return [];
  const items = new Map<string, CalendarItem>();
  const add = (item: CalendarItem) => {
    if (item.startsAt < end && (item.endsAt ?? item.startsAt + 1) > start)
      items.set(item.id, item);
  };
  const occurrenceTimes = (
    schedule: LocalSchedule,
    nextDueAt: number | null,
    beginsAt: number,
    duration = 0,
    lastStart?: number | null,
  ): number[] => {
    // The inclusive series limit applies to starts, never durations or recorded history.
    const until = lastStart == null ? end : Math.min(end, lastStart + 1);
    if (nextDueAt === null || nextDueAt >= until) return [];
    // Include an overnight planned session, but never infer a past execution.
    const from = start - duration;
    const times = new Set<number>();
    // An overdue authoritative slot remains due; it is not a fabricated failed run.
    if (nextDueAt >= from && nextDueAt >= beginsAt) times.add(nextDueAt);
    let cursor = Math.max(from, now, nextDueAt, beginsAt) - 1;
    const count =
      schedule.kind === "daily" ||
      schedule.kind === "weekly" ||
      schedule.kind === "once"
        ? Math.min(64, Math.ceil((until - cursor) / 86400000) + 1)
        : 64;
    while (cursor < until && count > 0) {
      const batch = localOccurrences(schedule, { after: cursor, count });
      for (const at of batch)
        if (at >= from && at >= beginsAt && at < until) times.add(at);
      const last = batch.at(-1);
      if (
        last === undefined ||
        last <= cursor ||
        last >= until ||
        batch.length < count
      )
        break;
      cursor = last;
    }
    return [...times].sort((a, b) => a - b);
  };

  const occurred = new Set<string>();
  for (const run of eventRuns) {
    const event = run.event;
    if (run.trigger !== "manual")
      occurred.add(`${run.eventId}:${run.scheduledFor}`);
    add({
      id: `event-run:${run.id}`,
      kind: "event",
      title: event.title,
      startsAt: run.scheduledFor,
      endsAt:
        event.durationMinutes === null
          ? null
          : run.scheduledFor + event.durationMinutes * 60000,
      coworkerSlugs: event.participantSlugs,
      status: run.status,
      planned: false,
      placement: "local",
      eventId: run.eventId,
      eventRunId: run.id,
      ownerSlug: event.leadSlug,
      summary: run.outcome?.summary || run.error,
    });
  }
  for (const event of events) {
    if (event.state !== "active") continue;
    for (const at of occurrenceTimes(
      event.schedule,
      event.nextDueAt,
      event.startsAt,
      (event.durationMinutes ?? 0) * 60000,
      event.repeatUntil,
    )) {
      if (occurred.has(`${event.id}:${at}`)) continue;
      add({
        id: `event:${event.id}:${at}`,
        kind: "event",
        title: event.title,
        startsAt: at,
        endsAt:
          event.durationMinutes === null
            ? null
            : at + event.durationMinutes * 60000,
        coworkerSlugs: event.participantSlugs,
        status: at <= now ? "due" : "scheduled",
        planned: true,
        placement: "local",
        eventId: event.id,
        ownerSlug: event.leadSlug,
        summary: event.objective,
      });
    }
  }

  for (const responsibility of responsibilities) {
    if (responsibility.ownerSlugs.length === 0) continue;
    const key =
      responsibility.placement === "local"
        ? `local:${responsibility.ownerSlugs[0]}:${responsibility.id}`
        : `${responsibility.placement}:${responsibility.id}`;
    const recorded = new Set<number>();
    for (const run of responsibility.runs) {
      if (run.scheduledFor !== null) recorded.add(run.scheduledFor);
      add({
        id: `responsibility-run:${key}:${run.id}`,
        kind: "responsibility",
        title: responsibility.name,
        startsAt: run.at,
        endsAt: run.finishedAt,
        coworkerSlugs: responsibility.ownerSlugs,
        status: run.status,
        planned: false,
        placement: responsibility.placement,
        responsibilityId: responsibility.id,
        ownerSlug: responsibility.ownerSlugs[0],
        threadId: run.threadId,
        summary: run.summary,
      });
    }
    if (responsibility.state !== "active") continue;
    for (const at of occurrenceTimes(
      responsibility.schedule,
      responsibility.nextDueAt,
      responsibility.createdAt,
    )) {
      if (recorded.has(at)) continue;
      add({
        id: `responsibility:${key}:${at}`,
        kind: "responsibility",
        title: responsibility.name,
        startsAt: at,
        endsAt: null,
        coworkerSlugs: responsibility.ownerSlugs,
        status: at <= now ? "due" : "scheduled",
        planned: true,
        placement: responsibility.placement,
        responsibilityId: responsibility.id,
        ownerSlug: responsibility.ownerSlugs[0],
        summary: responsibility.instructions,
      });
    }
  }
  return [...items.values()].sort(
    (a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id),
  );
}
