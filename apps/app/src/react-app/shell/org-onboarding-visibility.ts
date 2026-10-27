import { useSyncExternalStore } from "react";

// The organization onboarding route renders its own loading, error and Retry
// states and does not need the local engine. While it is on screen, the boot
// overlay must not cover it: a timed-out organization request would otherwise
// hide its Retry behind "Preparing workspace" with no way forward.
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
