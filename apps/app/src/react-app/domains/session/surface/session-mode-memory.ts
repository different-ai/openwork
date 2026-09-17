import { useCallback, useEffect } from "react";
import { create } from "zustand";

const STORAGE_KEY = "openwork.sessionAgents.v1";
const MAX_REMEMBERED_SESSIONS = 200;

type SessionAgentSelections = Record<string, string | null>;

function capSelections(selections: SessionAgentSelections): SessionAgentSelections {
  return Object.fromEntries(Object.entries(selections).slice(-MAX_REMEMBERED_SESSIONS));
}

export function readSessionAgentSelections(): SessionAgentSelections {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: [string, string | null][] = [];
    for (const [sessionId, value] of Object.entries(parsed)) {
      const agent: unknown = value;
      if (!sessionId.trim() || (agent !== null && (typeof agent !== "string" || !agent.trim()))) continue;
      entries.push([sessionId, agent]);
    }
    return Object.fromEntries(entries.slice(-MAX_REMEMBERED_SESSIONS));
  } catch {
    return {};
  }
}

type SessionAgentStore = {
  bySessionId: SessionAgentSelections;
  setAgent: (sessionId: string, agent: string | null) => void;
};

export const useSessionAgentStore = create<SessionAgentStore>((set) => ({
  bySessionId: readSessionAgentSelections(),
  setAgent: (sessionId, agent) => set((state) => {
    if (!sessionId.trim()) return state;
    if (Object.hasOwn(state.bySessionId, sessionId) && state.bySessionId[sessionId] === agent) return state;
    const { [sessionId]: _replaced, ...rest } = state.bySessionId;
    const bySessionId = capSelections({ ...rest, [sessionId]: agent });
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bySessionId));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
    return { bySessionId };
  }),
}));

export function getSessionAgentSelection(sessionId: string, fallbackAgent: string | null = null): string | null {
  const selections = useSessionAgentStore.getState().bySessionId;
  return Object.hasOwn(selections, sessionId) ? selections[sessionId] : fallbackAgent;
}

export function useSessionAgentSelection(input: {
  sessionId: string | null;
  fallbackAgent: string | null;
  onFallbackAgentChange: (agent: string | null) => void;
}) {
  const { sessionId, fallbackAgent, onFallbackAgentChange } = input;
  const selection = useSessionAgentStore((state) => sessionId && Object.hasOwn(state.bySessionId, sessionId)
    ? state.bySessionId[sessionId]
    : undefined);
  // Adopt the existing preference once, not whenever another new task changes it.
  // A remembered null is an explicit Default choice, not missing memory.
  useEffect(() => {
    if (!sessionId) return;
    const store = useSessionAgentStore.getState();
    if (!Object.hasOwn(store.bySessionId, sessionId)) store.setAgent(sessionId, fallbackAgent);
  }, [fallbackAgent, sessionId]);
  const setAgent = useCallback((agent: string | null) => {
    if (sessionId) useSessionAgentStore.getState().setAgent(sessionId, agent);
    else onFallbackAgentChange(agent);
  }, [onFallbackAgentChange, sessionId]);
  return { selectedAgent: selection === undefined ? fallbackAgent : selection, setAgent };
}
