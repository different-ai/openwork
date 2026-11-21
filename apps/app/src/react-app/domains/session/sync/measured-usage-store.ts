import { create } from "zustand";
import type { MessageTokens } from "@/app/types";

import { toRecord } from "./unknown-values";

export type MeasuredUsage = {
  messageId: string;
  tokens: MessageTokens;
};

export type UsageMeasuredProperties = {
  sessionID: string;
  messageID: string;
  tokens: MessageTokens;
};

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function readUsageMeasured(properties: unknown): UsageMeasuredProperties | null {
  const props = toRecord(properties);
  const tokens = toRecord(props.tokens);
  const cache = toRecord(tokens.cache);
  const { sessionID, messageID } = props;
  const { input, output, reasoning, total } = tokens;
  const { read, write } = cache;
  if (typeof sessionID !== "string" || typeof messageID !== "string") return null;
  if (!isCount(input) || !isCount(output) || !isCount(reasoning) || !isCount(read) || !isCount(write)) return null;
  return { sessionID, messageID, tokens: { ...(isCount(total) ? { total } : {}), input, output, reasoning, cache: { read, write } } };
}

type MeasuredUsageState = {
  bySession: Record<string, MeasuredUsage>;
  record: (workspaceId: string, sessionId: string, usage: MeasuredUsage) => void;
  clear: (workspaceId: string, sessionId: string) => void;
};

const isEmpty = (tokens: MessageTokens) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write <= 0;

export const measuredUsageKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);

export const useMeasuredUsageStore = create<MeasuredUsageState>((set) => ({
  bySession: {},
  record: (workspaceId, sessionId, usage) => set((state) => {
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
