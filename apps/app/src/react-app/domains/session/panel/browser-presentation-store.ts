import { create } from "zustand";

import type { BrowserPresentationMode } from "@/app/lib/desktop";

export type { BrowserPresentationMode };
export type BrowserShownMode = "floating" | "side";

export type BrowserPresentation = {
  mode: BrowserPresentationMode;
  returnMode: BrowserShownMode;
};

type BrowserPresentationStore = {
  sessions: Record<string, BrowserPresentation>;
  setMode: (sessionId: string, mode: BrowserPresentationMode, returnMode?: BrowserShownMode) => void;
  moveSession: (from: string, to: string) => void;
  dropFullscreen: (sessionId: string) => void;
};

export const DEFAULT_BROWSER_PRESENTATION: BrowserPresentation = {
  mode: "hidden",
  returnMode: "side",
};

function update(
  sessions: Record<string, BrowserPresentation>,
  sessionId: string,
  next: Partial<BrowserPresentation>,
): Record<string, BrowserPresentation> {
  const current = sessions[sessionId] ?? DEFAULT_BROWSER_PRESENTATION;
  const merged = { ...current, ...next };
  if (merged.mode === current.mode && merged.returnMode === current.returnMode) return sessions;
  return { ...sessions, [sessionId]: merged };
}

export const useBrowserPresentationStore = create<BrowserPresentationStore>()((set) => ({
  sessions: {},
  setMode: (sessionId, mode, returnMode) => set((state) => ({
    sessions: update(state.sessions, sessionId, returnMode ? { mode, returnMode } : { mode }),
  })),
  moveSession: (from, to) => set((state) => {
    const moved = state.sessions[from];
    if (!moved) return state;
    const { [from]: _moved, ...sessions } = state.sessions;
    return { sessions: { ...sessions, [to]: moved } };
  }),
  dropFullscreen: (sessionId) => set((state) => {
    const current = state.sessions[sessionId];
    if (current?.mode !== "fullscreen") return state;
    return { sessions: update(state.sessions, sessionId, { mode: current.returnMode }) };
  }),
}));

export function useBrowserPresentation(sessionId: string): BrowserPresentation {
  return useBrowserPresentationStore((state) => state.sessions[sessionId] ?? DEFAULT_BROWSER_PRESENTATION);
}
