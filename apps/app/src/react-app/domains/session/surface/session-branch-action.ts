import { useCallback, useSyncExternalStore } from "react";

type SessionBranchAction =
  | { status: "pending"; messageId: string; promise: Promise<void> }
  | { status: "failed"; error: unknown };

// A surface owns navigation, but the request outlives that surface. Keep its
// claim through both the history read and fork POST, including across remounts.
const actions = new Map<string, SessionBranchAction>();
const listeners = new Map<string, Set<() => void>>();

function notify(owner: string) {
  for (const listener of listeners.get(owner) ?? []) listener();
}

export function runSessionBranchAction(owner: string, messageId: string, run: () => Promise<void>): Promise<void> {
  const existing = actions.get(owner);
  if (existing?.status === "pending") return existing.promise;
  const promise = Promise.resolve().then(run).catch((error: unknown) => {
    // Only retain failure feedback for a mounted subscriber, never its request.
    if (listeners.get(owner)?.size) actions.set(owner, { status: "failed", error });
    throw error;
  }).finally(() => {
    if (actions.get(owner) === action) actions.delete(owner);
    notify(owner);
  });
  const action: SessionBranchAction = { status: "pending", messageId, promise };
  actions.set(owner, action);
  notify(owner);
  return promise;
}

export function useSessionBranchAction(owner: string) {
  const subscribe = useCallback((listener: () => void) => {
    const subscribers = listeners.get(owner) ?? new Set<() => void>();
    subscribers.add(listener);
    listeners.set(owner, subscribers);
    return () => {
      subscribers.delete(listener);
      if (subscribers.size) return;
      listeners.delete(owner);
      if (actions.get(owner)?.status === "failed") actions.delete(owner);
    };
  }, [owner]);
  const snapshot = useCallback(() => actions.get(owner), [owner]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
