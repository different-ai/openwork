import path from "node:path";
import { ASSIGNMENT_TOOL_NAMES } from "../src/lib/coworker-tools.ts";

export const EVENT_SAFETY_MINUTES = 240;
export const EVENT_CONTEXT_LIMIT = 3500;
export const EVENT_DYNAMIC_LIMIT = 6000;
export const EVENT_WRITE_LIMIT = 5;
export const EVENT_WRITE_DENY = Object.freeze({ coworker_event_create: false, coworker_event_update: false, coworker_event_manage: false });
export const EVENT_SCHEDULE_DENY = Object.freeze({ ...EVENT_WRITE_DENY, ...Object.fromEntries(ASSIGNMENT_TOOL_NAMES.filter((name) => name !== "assignments_list").map((name) => [`coworker_${name}`, false])) });
export function isEventDeactivation(name, args) {
  return name === "coworker_event_manage" && ["pause", "archive"].includes(args?.action)
    || name === "coworker_event_update" && ["paused", "archived"].includes(args?.input?.state);
}
export const ALL_HANDS_BRIEF = "This All Hands briefing is read-only: gather current evidence, cite sources and timestamps, distinguish facts from proposals, and say when information is missing. Do not execute proposed work or perform external writes. This briefing grants no new permissions.";
export const eventRunLive = (run) => run && ["queued", "running", "waiting"].includes(run.status);

export function eventRunFor(state, owner, now = Date.now()) {
  if (!owner?.eventRunId) return null;
  const run = state.workplaceEvents?.runs[owner.eventRunId];
  if (!eventRunLive(run) || run.cancelRequested || run.event.groupId !== owner.groupId
    || !run.identities[owner.slug] || (run.deadlineAt && run.deadlineAt <= now)) {
    throw new Error("This event session stopped, expired, or no longer owns this execution.");
  }
  return run;
}

/** Requested dependencies and each originating task's handback reserve capacity before work starts. */
export function assertEventReplyBudget(state, run, addition) {
  const tasks = Object.values(state.tasks).filter((task) => task.owner.eventRunId === run.id);
  const usage = [...Object.entries(run.usage), ...(addition ? [addition] : [])].map(([id, entry]) => ({ ...entry,
    taskId: entry.taskId ?? state.executions[id]?.taskId ?? tasks.find((task) => task.workerId && id.startsWith(`worker:${task.workerId}:`))?.id,
  }));
  const missing = run.event.participantSlugs.filter((slug) => !usage.some((entry) => entry.kind === "contribution" && entry.slug === slug)).length;
  const conclusion = usage.some((entry) => entry.kind === "conclusion") ? 0 : 1;
  const pending = tasks.filter((task) => !task.cancelRequested && !["succeeded", "failed", "cancelled"].includes(task.state));
  const firstReplies = pending.filter((task) => ["worker", "consultation"].includes(task.kind)
    && !usage.some((entry) => entry.taskId === task.id && entry.kind === task.kind)).length;
  const handbacks = pending.filter((task) => task.dependencies.length && !task.continuationId
    && !usage.some((entry) => entry.kind === "continuation" && entry.taskId === task.id && entry.generation === task.generation)).length;
  if (usage.length + missing + conclusion + firstReplies + handbacks > run.event.maxReplies) throw new Error("This event reached its reply budget. Remaining participant replies, requested dependencies, each originating task's handback and the lead conclusion are reserved.");
}

/** Reservations share the same commit as native admission; recovery consumes no second reply. */
export function reserveEventReply(state, owner, id, kind, now = Date.now(), taskId = id) {
  const run = eventRunFor(state, owner, now);
  if (!run || run.usage[id]) return;
  const entry = { kind, slug: owner.slug, taskId, generation: state.tasks[taskId]?.generation ?? 0 };
  assertEventReplyBudget(state, run, [id, entry]);
  run.usage[id] = entry;
}

export function coworkerIdentity(coworker) {
  if (!coworker?.slug || typeof coworker.createdAt !== "string" || !coworker.createdAt || !coworker.path) throw new Error("A saved coworker identity is required for this event.");
  return { slug: coworker.slug, createdAt: coworker.createdAt, path: path.resolve(coworker.path), workspaceId: coworker.workspaceId || "" };
}

export function assertEventIdentity(expected, coworker) {
  if (expected?.unresolved) throw new Error("This legacy participant's original identity was unavailable during migration. Remove it from the event before running; a same-slug replacement cannot inherit it.");
  const actual = coworkerIdentity(coworker);
  if (!expected || expected.slug !== actual.slug || expected.createdAt !== actual.createdAt || expected.path !== actual.path
    || (expected.workspaceId && expected.workspaceId !== actual.workspaceId)) {
    throw new Error("An event participant's original identity or workspace changed. A replacement with the same slug cannot inherit this session.");
  }
}
