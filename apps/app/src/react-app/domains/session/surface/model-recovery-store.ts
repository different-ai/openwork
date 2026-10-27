import { create } from "zustand";
import type { ModelRef } from "@/app/types";

export type ModelRecovery = {
  previous: ModelRef & { title?: string };
  replacement: ModelRef & { title?: string };
  returned: boolean;
  dismissed: boolean;
};

type RecoveryState = {
  byChat: Record<string, ModelRecovery>;
  record: (chat: string, recovery: Omit<ModelRecovery, "returned" | "dismissed">) => void;
  markReturned: (chat: string, returned: boolean) => void;
  dismiss: (chat: string) => void;
  clear: (chat: string) => void;
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
}));

export function modelRecoveryChatKey(scope: string, sessionId?: string | null) {
  return JSON.stringify([scope, sessionId ?? "new-task"]);
}
