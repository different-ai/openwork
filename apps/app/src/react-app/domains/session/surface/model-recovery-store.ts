import { create } from "zustand";
import { useLayoutEffect } from "react";
import type { ModelRef } from "@/app/types";

export type ModelRecovery = {
  previous: ModelRef & { title?: string };
  replacement: ModelRef & { title?: string };
  returned: boolean;
  dismissed: boolean;
  /** New-chat recovery is temporary, and expires when its configured default changes. */
  defaultSelectionKey?: string;
};

type RecoveryState = {
  byChat: Record<string, ModelRecovery>;
  record: (chat: string, recovery: Omit<ModelRecovery, "returned" | "dismissed">) => void;
  markReturned: (chat: string, returned: boolean) => void;
  dismiss: (chat: string) => void;
  clear: (chat: string) => void;
  expireDefault: (chat: string, configuredKey: string) => void;
};

/** Ephemeral, scoped to account/workspace/chat; never changes a global model preference. */
export const useModelRecoveryStore = create<RecoveryState>((set) => ({
  byChat: {},
  record: (chat, recovery) => set((state) => ({ byChat: { ...state.byChat, [chat]: { ...recovery, returned: false, dismissed: false } } })),
  markReturned: (chat, returned) => set((state) => {
    const recovery = state.byChat[chat];
    if (!recovery || recovery.returned === returned) return state;
    return { byChat: { ...state.byChat, [chat]: { ...recovery, returned, dismissed: returned ? false : recovery.dismissed } } };
  }),
  dismiss: (chat) => set((state) => {
    const recovery = state.byChat[chat];
    return recovery ? { byChat: { ...state.byChat, [chat]: { ...recovery, dismissed: true } } } : state;
  }),
  clear: (chat) => set((state) => {
    const byChat = { ...state.byChat };
    delete byChat[chat];
    return { byChat };
  }),
  expireDefault: (chat, configuredKey) => set((state) => {
    const recovery = state.byChat[chat];
    if (!recovery?.defaultSelectionKey || recovery.defaultSelectionKey === configuredKey) return state;
    const byChat = { ...state.byChat };
    delete byChat[chat];
    return { byChat };
  }),
}));

/** Retire both effective recovery and its note before painting a verified new default, even when the new default adopts the replacement itself. */
export function useDefaultModelRecovery(chat: string, configuredKey: string, verified: boolean) {
  const recovery = useModelRecoveryStore((state) => state.byChat[chat]);
  useLayoutEffect(() => {
    if (verified) useModelRecoveryStore.getState().expireDefault(chat, configuredKey);
  }, [chat, configuredKey, verified, recovery?.defaultSelectionKey]);
  return recovery;
}

/** A recovery never becomes a personal workspace preference or masks a later org default. */
export function temporaryRecoveredDefault(
  configured: { model: ModelRef | null; variant: string | null },
  recovery: ModelRecovery | undefined,
  defaultSelectionKey: string,
): { model: ModelRef | null; variant: string | null } {
  return recovery?.defaultSelectionKey === defaultSelectionKey
    ? { model: recovery.replacement, variant: null }
    : configured;
}

export function modelRecoveryChatKey(scope: string, sessionId?: string | null) {
  return JSON.stringify([scope, sessionId ?? "new-task"]);
}
