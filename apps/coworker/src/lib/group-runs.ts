/** Renderer projections only. The main process owns execution and its durable queue. */
import { coworkerBridge, type CoworkerGroupTurn, type GroupTimelineEvent } from "./bridge.ts";

export type QueuedGroupMessage = { clientMessageId: string; text: string };
export type GroupRunUpdate = {
  groupId: string;
  turn?: CoworkerGroupTurn;
  event?: GroupTimelineEvent;
  queue?: QueuedGroupMessage[];
  active?: boolean;
  done?: boolean;
};
const runs = new Map<string, { groupId: string; turn: CoworkerGroupTurn | null }>();
const listeners = new Set<(update: GroupRunUpdate) => void>();

export function subscribeGroupRuns(listener: (update: GroupRunUpdate) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishGroupRun(update: GroupRunUpdate): void {
  if (update.active || update.turn) runs.set(update.groupId, { groupId: update.groupId, turn: update.turn ?? null });
  if (update.done || update.active === false) runs.delete(update.groupId);
  for (const listener of listeners) listener(update);
}
export function liveGroupRun(groupId: string) { return runs.get(groupId) ?? null; }
export async function stopGroupRun(groupId: string): Promise<void> { await coworkerBridge.groups.cancel(groupId); }
