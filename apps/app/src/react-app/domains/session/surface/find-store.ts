import { create } from "zustand";

type OpenFindOptions = {
  sessionId: string;
};

type SessionFindStore = {
  open: boolean;
  sessionId: string | null;
  lastFocusedSessionId: string | null;
  query: string;
  appliedQuery: string;
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
  focusNonce: 0,
  openFind: (opts) => set((state) => ({
    open: true,
    sessionId: opts.sessionId,
    appliedQuery: state.query,
    focusNonce: state.focusNonce + 1,
  })),
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
  }),
}));
