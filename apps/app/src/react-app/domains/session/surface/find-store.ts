import { create } from "zustand";

export type SessionFindTarget = {
  sessionId: string;
  messageId?: string;
};

type OpenFindOptions = {
  sessionId: string;
  query?: string;
  target?: SessionFindTarget;
};

type SessionFindStore = {
  open: boolean;
  sessionId: string | null;
  lastFocusedSessionId: string | null;
  query: string;
  appliedQuery: string;
  target: SessionFindTarget | null;
  focusNonce: number;
  openFind: (opts: OpenFindOptions) => void;
  setLastFocused: (sessionId: string) => void;
  setQuery: (query: string) => void;
  setAppliedQuery: (query: string) => void;
  closeFind: () => void;
};

export const useSessionFindStore = create<SessionFindStore>((set) => ({
  open: false,
  sessionId: null,
  lastFocusedSessionId: null,
  query: "",
  appliedQuery: "",
  target: null,
  focusNonce: 0,
  openFind: (opts) => set((state) => {
    const query = opts.query ?? state.query;
    return {
      open: true,
      sessionId: opts.sessionId,
      query,
      appliedQuery: query,
      target: opts.target ?? null,
      focusNonce: state.focusNonce + 1,
    };
  }),
  setLastFocused: (lastFocusedSessionId) => set((state) => (
    state.lastFocusedSessionId === lastFocusedSessionId ? state : { lastFocusedSessionId }
  )),
  setQuery: (query) => set((state) => (
    state.query === query ? state : { query }
  )),
  setAppliedQuery: (appliedQuery) => set((state) => (
    state.appliedQuery === appliedQuery ? state : { appliedQuery }
  )),
  closeFind: () => set({
    open: false,
    sessionId: null,
    query: "",
    appliedQuery: "",
    target: null,
  }),
}));
