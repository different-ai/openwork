import { useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { useOptionalMessageList } from "@/components/chat/message-list-provider";

export const MAX_WORKBENCH_DISCLOSURES = 2048;
export const MAX_WORKBENCH_SPLIT_RATIOS = 32;

function boundedEntry<T>(entries: ReadonlyMap<string, T>, key: string, value: T, limit: number) {
  const next = new Map(entries);
  next.delete(key);
  next.set(key, value);
  while (next.size > limit) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

// Only interaction metadata, never transcript bodies, credentials, or retained DOM.
// These bounded, last-written caches deliberately do not survive an app restart.
export const useWorkbenchUiState = create<{
  disclosures: ReadonlyMap<string, boolean>;
  splitRatios: ReadonlyMap<string, number>;
  setDisclosure: (key: string, open: boolean) => void;
  setSplitRatio: (owner: string, ratio: number) => void;
}>((set) => ({
  disclosures: new Map(),
  splitRatios: new Map(),
  setDisclosure: (key, open) => set((state) => ({
    disclosures: boundedEntry(state.disclosures, key, open, MAX_WORKBENCH_DISCLOSURES),
  })),
  setSplitRatio: (owner, ratio) => {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 100) return;
    set((state) => ({
      splitRatios: boundedEntry(state.splitRatios, owner, ratio, MAX_WORKBENCH_SPLIT_RATIOS),
    }));
  },
}));

export function useWorkbenchDisclosure(detail: string | undefined, defaultOpen = false): [boolean, (open: boolean) => void] {
  const context = useOptionalMessageList();
  const owner = context?.uiStateOwner;
  const key = owner && detail ? JSON.stringify([owner, detail]) : null;
  const localKey = JSON.stringify([context?.workspaceId, context?.sessionId, owner, detail]);
  // Defaults initialize a new identity only; saved false is an explicit choice.
  const saved = key ? useWorkbenchUiState.getState().disclosures.get(key) ?? defaultOpen : defaultOpen;
  const [local, setLocal] = useState({ key: localKey, open: saved });
  if (local.key !== localKey) setLocal({ key: localKey, open: saved });
  useLayoutEffect(() => {
    if (!key) return;
    const update = (open: boolean | undefined) => {
      // Eviction forgets restoration metadata, not the mounted reader's choice.
      if (open === undefined) return;
      setLocal((current) => current.key === localKey && current.open !== open
        ? { key: localKey, open } : current);
    };
    const unsubscribe = useWorkbenchUiState.subscribe((state, previous) => {
      const open = state.disclosures.get(key);
      if (open !== previous.disclosures.get(key)) update(open);
    });
    update(useWorkbenchUiState.getState().disclosures.get(key));
    return unsubscribe;
  }, [key, localKey]);
  return [local.key === localKey ? local.open : saved, (open) => {
    setLocal({ key: localKey, open });
    if (key) useWorkbenchUiState.getState().setDisclosure(key, open);
  }];
}
