/**
 * Live group turns, kept outside any one view. A turn keeps running when the
 * person opens another coworker or group: its replies still land in the store,
 * the rail still says who is replying, and the view picks the run up again when
 * it comes back. Messages sent while a turn runs wait here as the next turns.
 */
import type { CoworkerGroupTurn, GroupTimelineEvent } from "./bridge.ts";

export type QueuedGroupMessage = { clientMessageId: string; text: string };

export type GroupRunUpdate = {
  groupId: string;
  /** The turn record as last stored. */
  turn?: CoworkerGroupTurn;
  /** A timeline line appended by the run. */
  event?: GroupTimelineEvent;
  /** The queue after a change to it. */
  queue?: QueuedGroupMessage[];
  /** The run finished (or failed); nothing is live for this group any more. */
  done?: boolean;
};

export type LiveGroupRun = {
  groupId: string;
  controller: AbortController;
  /** The latest stored turn record, once routing has produced one. */
  turn: CoworkerGroupTurn | null;
  /** Aborts the native turn of the speaker replying right now, when one is. */
  abortCurrent: (() => Promise<unknown>) | null;
};

const runs = new Map<string, LiveGroupRun>();
const queues = new Map<string, QueuedGroupMessage[]>();
const listeners = new Set<(update: GroupRunUpdate) => void>();

export function subscribeGroupRuns(listener: (update: GroupRunUpdate) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishGroupRun(update: GroupRunUpdate): void {
  for (const listener of listeners) listener(update);
}

export function liveGroupRun(groupId: string): LiveGroupRun | null {
  return runs.get(groupId) ?? null;
}

/** Coworkers replying right now in some other group: "busy" to a facilitator choosing speakers. */
export function busyGroupSpeakers(exceptGroupId = ""): Set<string> {
  const busy = new Set<string>();
  for (const run of runs.values()) {
    if (run.groupId === exceptGroupId) continue;
    for (const speaker of run.turn?.speakers ?? []) if (speaker.status === "running") busy.add(speaker.slug);
  }
  return busy;
}

export function queuedGroupMessages(groupId: string): QueuedGroupMessage[] {
  return queues.get(groupId) ?? [];
}

export function enqueueGroupMessage(groupId: string, message: QueuedGroupMessage): QueuedGroupMessage[] {
  const next = [...queuedGroupMessages(groupId), message];
  queues.set(groupId, next);
  publishGroupRun({ groupId, queue: next });
  return next;
}

export function dequeueGroupMessage(groupId: string, clientMessageId?: string): QueuedGroupMessage | null {
  const current = queuedGroupMessages(groupId);
  const index = clientMessageId ? current.findIndex((message) => message.clientMessageId === clientMessageId) : 0;
  if (index === -1 || current.length === 0) return null;
  const [removed] = current.splice(index, 1);
  queues.set(groupId, [...current]);
  publishGroupRun({ groupId, queue: [...current] });
  return removed ?? null;
}

/**
 * Register a run for a group and execute it. Only one run per group is live at
 * a time; a second request while one is live is refused so two turns never
 * interleave in the timeline. The run is unregistered however it ends.
 */
export async function startGroupRun(groupId: string, execute: (run: LiveGroupRun) => Promise<void>): Promise<void> {
  if (runs.has(groupId)) throw new Error("This group is already replying.");
  const run: LiveGroupRun = { groupId, controller: new AbortController(), turn: null, abortCurrent: null };
  runs.set(groupId, run);
  try {
    await execute(run);
  } finally {
    runs.delete(groupId);
    publishGroupRun({ groupId, done: true });
  }
}

/** Stop the live run of a group: the in-flight native turn is aborted and the rest are marked stopped by the runner. */
export async function stopGroupRun(groupId: string): Promise<void> {
  const run = runs.get(groupId);
  if (!run) return;
  run.controller.abort();
  await run.abortCurrent?.().catch(() => undefined);
}
