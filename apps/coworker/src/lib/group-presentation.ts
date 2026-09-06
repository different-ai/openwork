import type { CoworkerGroupTurn, GroupInteraction, GroupTimelineEvent } from "./bridge";
import { describeGroupActivity, listNames } from "./groups.ts";
import type { ExecutionActivity } from "./progress-activity";

/** Presentation only: a human wait takes precedence over replying and queued work. */
export function describeGroupPresentation({ events, executions, interactions, active, turn, nameFor, unavailable = false }: {
  events: readonly GroupTimelineEvent[];
  executions: readonly ExecutionActivity[];
  interactions: readonly Pick<GroupInteraction, "slug">[];
  active: boolean;
  turn: CoworkerGroupTurn | null;
  nameFor: (slug: string) => string;
  unavailable?: boolean;
}): { line: string; activeSlugs: string[] } {
  if (interactions.length) return { activeSlugs: [], line: `${listNames([...new Set(interactions.map((entry) => entry.slug))].map(nameFor))} waiting for you` };
  if (unavailable) return { activeSlugs: [], line: "Activity unavailable" };
  const activeSlugs = [...new Set(executions
    .filter((execution) => execution.state === "running" && execution.available && execution.nativeStatus === "busy")
    .map((execution) => execution.slug))];
  if (activeSlugs.length) return { activeSlugs, line: `${listNames(activeSlugs.map(nameFor))} ${activeSlugs.length === 1 ? "is" : "are"} replying\u2026` };
  const running = executions.filter((execution) => execution.state === "running");
  if (running.some((execution) => !execution.available || execution.nativeStatus === "unknown")) return { activeSlugs, line: "Activity unavailable" };
  if (running.some((execution) => execution.nativeStatus === "retry")) return { activeSlugs, line: "Waiting for the AI model" };
  if (running.some((execution) => execution.nativeStatus === "idle")) return { activeSlugs, line: running.some((execution) => execution.pendingCoworkers > 0 || execution.pendingWorkers > 0) ? "Waiting for requested work" : "Waiting for a reply" };
  if (executions.some((execution) => execution.state === "queued")) return { activeSlugs, line: "Waiting to start" };
  if (active) return { activeSlugs, line: turn?.status === "running" ? "Waiting for a reply" : "Choosing who should respond\u2026" };

  const latest = events.findLast((event) => event.kind === "user" || event.kind === "coworker");
  if (latest?.kind === "coworker" && latest.turnId) {
    const replied = [...new Set(events.flatMap((event) => event.kind === "coworker" && event.turnId === latest.turnId && event.slug ? [event.slug] : []))];
    if (replied.length) return { activeSlugs, line: `${listNames(replied.map(nameFor))} replied` };
  }
  return { activeSlugs, line: describeGroupActivity(events, nameFor) };
}
