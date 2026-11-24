import { useSyncExternalStore } from "react";

let visible = false;
const listeners = new Set<() => void>();

export function setOrgOnboardingOnScreen(next: boolean): void {
  if (visible === next) return;
  visible = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOrgOnboardingOnScreen(): boolean {
  return useSyncExternalStore(subscribe, () => visible, () => false);
}
