import { create } from "zustand";

import type { BrowserPresentationMode } from "@/app/lib/desktop";

export type { BrowserPresentationMode };
export type BrowserFloatingSnap = "top" | "middle" | "bottom";
export type BrowserShownMode = "floating" | "side";

/**
 * How one conversation shows its built-in browser. `side` is the docked side
 * panel; `returnMode` is the person's last floating/side choice, used when
 * leaving full screen, reopening from the header and placing a page the agent
 * opened. In memory only: a restart starts hidden.
 */
export type BrowserPresentation = {
  mode: BrowserPresentationMode;
  snap: BrowserFloatingSnap;
  returnMode: BrowserShownMode;
};

type BrowserPresentationStore = {
  sessions: Record<string, BrowserPresentation>;
  setMode: (sessionId: string, mode: BrowserPresentationMode, returnMode?: BrowserShownMode) => void;
  setSnap: (sessionId: string, snap: BrowserFloatingSnap) => void;
  /** Full screen never outlives its conversation or its page: fall back to `returnMode`. */
  dropFullscreen: (sessionId: string) => void;
};

export const DEFAULT_BROWSER_PRESENTATION: BrowserPresentation = {
  mode: "hidden",
  snap: "middle",
  returnMode: "floating",
};

function update(
  sessions: Record<string, BrowserPresentation>,
  sessionId: string,
  next: Partial<BrowserPresentation>,
): Record<string, BrowserPresentation> {
  const current = sessions[sessionId] ?? DEFAULT_BROWSER_PRESENTATION;
  const merged = { ...current, ...next };
  if (merged.mode === current.mode && merged.snap === current.snap && merged.returnMode === current.returnMode) return sessions;
  return { ...sessions, [sessionId]: merged };
}

export const useBrowserPresentationStore = create<BrowserPresentationStore>()((set) => ({
  sessions: {},
  setMode: (sessionId, mode, returnMode) => set((state) => ({
    sessions: update(state.sessions, sessionId, returnMode ? { mode, returnMode } : { mode }),
  })),
  setSnap: (sessionId, snap) => set((state) => ({ sessions: update(state.sessions, sessionId, { snap }) })),
  dropFullscreen: (sessionId) => set((state) => {
    const current = state.sessions[sessionId];
    if (current?.mode !== "fullscreen") return state;
    return { sessions: update(state.sessions, sessionId, { mode: current.returnMode }) };
  }),
}));

export function useBrowserPresentation(sessionId: string): BrowserPresentation {
  return useBrowserPresentationStore((state) => state.sessions[sessionId] ?? DEFAULT_BROWSER_PRESENTATION);
}
