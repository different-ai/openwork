import { create } from "zustand";
import type { MessageTokens } from "@/app/types";

export type MeasuredUsage = {
  messageId: string;
  tokens: MessageTokens;
};

type MeasuredUsageState = {
  bySession: Record<string, MeasuredUsage>;
  record: (workspaceId: string, sessionId: string, usage: MeasuredUsage) => void;
  clear: (workspaceId: string, sessionId: string) => void;
};

const isEmpty = (tokens: MessageTokens) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write <= 0;

export const measuredUsageKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);

/**
 * The usage the provider reported for the latest finished assistant message of
 * a session, as seen on the live event stream. It lives beside the transcript,
 * not in it: the transcript rows are rebuilt from several sources, and a late
 * partial update must never erase a measured figure.
 */
export const useMeasuredUsageStore = create<MeasuredUsageState>((set) => ({
  bySession: {},
  record: (workspaceId, sessionId, usage) => set((state) => {
    // A message still streaming reports zeros; they are not a measurement.
    if (isEmpty(usage.tokens)) return state;
    const key = measuredUsageKey(workspaceId, sessionId);
    const current = state.bySession[key];
    if (current?.messageId === usage.messageId && current.tokens === usage.tokens) return state;
    return { bySession: { ...state.bySession, [key]: usage } };
  }),
  clear: (workspaceId, sessionId) => set((state) => {
    const key = measuredUsageKey(workspaceId, sessionId);
    if (!(key in state.bySession)) return state;
    const bySession = { ...state.bySession };
    delete bySession[key];
    return { bySession };
  }),
}));
