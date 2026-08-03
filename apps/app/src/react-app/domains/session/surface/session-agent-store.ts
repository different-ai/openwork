// Per-conversation agent memory. Each session can pick its own agent from
// the composer; the choice is remembered in localStorage so returning to a
// conversation restores the agent it last used. A session with no stored
// choice has no entry here and falls back to the default agent. The global
// agent preference is only used outside of any session (the new-task composer).
import { create } from "zustand";

const STORAGE_KEY = "openwork.sessionAgents.v1";
const MAX_REMEMBERED_SESSIONS = 200;

function readStoredAgents(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, string> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        entries[sessionId] = value;
      }
    }
    return entries;
  } catch {
    return {};
  }
}

function writeStoredAgents(bySessionId: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bySessionId));
  } catch {
    // Ignore storage failures.
  }
}

function capAgents(bySessionId: Record<string, string>) {
  const keys = Object.keys(bySessionId);
  if (keys.length <= MAX_REMEMBERED_SESSIONS) return bySessionId;
  const trimmed: Record<string, string> = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED_SESSIONS)) {
    trimmed[key] = bySessionId[key]!;
  }
  return trimmed;
}

type SessionAgentStore = {
  bySessionId: Record<string, string>;
  setAgent: (sessionId: string, agent: string | null) => void;
};

export const useSessionAgentStore = create<SessionAgentStore>((set) => ({
  bySessionId: readStoredAgents(),
  setAgent: (sessionId, agent) =>
    set((state) => {
      const trimmed = agent?.trim() ?? "";
      if (!trimmed) {
        const { [sessionId]: _removed, ...rest } = state.bySessionId;
        writeStoredAgents(rest);
        return { bySessionId: rest };
      }
      const previous = state.bySessionId[sessionId];
      if (previous === trimmed) return state;
      const { [sessionId]: _replaced, ...rest } = state.bySessionId;
      const bySessionId = capAgents({ ...rest, [sessionId]: trimmed });
      writeStoredAgents(bySessionId);
      return { bySessionId };
    }),
}));
