import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const BROWSER_LOGIN_SYNC_STORE_KEY = "openwork:browser-login-sync:v1";

export type LoginSyncPromptOutcome = "synced" | "dismissed";

/**
 * Local memory for the one-time sync setup offer.
 */
export type BrowserLoginsState = {
  /** The effective value last observed, to notice an off-to-on transition. */
  lastEffectiveAllowed: boolean | null;
  prompt: {
    armedAt: number | null;
    shownAt: number | null;
    outcome: LoginSyncPromptOutcome | null;
  };
  observeEffectiveAllowed: (allowed: boolean, now?: number) => void;
  markPromptShown: (now?: number) => void;
  resolvePrompt: (outcome: LoginSyncPromptOutcome) => void;
};

export const usePersistedBrowserLoginsStore = create<BrowserLoginsState>()(
  persist(
    (set) => ({
      lastEffectiveAllowed: null,
      prompt: { armedAt: null, shownAt: null, outcome: null },
      observeEffectiveAllowed: (allowed, now = Date.now()) => set((state) => {
        if (state.lastEffectiveAllowed === allowed) return state;
        // Every off-to-on transition re-arms the prompt so the next visit to
        // the built-in browser offers setup, even if an earlier
        // offer was dismissed.
        const prompt = allowed ? { armedAt: now, shownAt: null, outcome: null } : state.prompt;
        return { lastEffectiveAllowed: allowed, prompt };
      }),
      markPromptShown: (now = Date.now()) => set((state) => (
        state.prompt.shownAt === null ? { prompt: { ...state.prompt, shownAt: now } } : state
      )),
      resolvePrompt: (outcome) => set((state) => ({ prompt: { ...state.prompt, outcome } })),
    }),
    {
      name: BROWSER_LOGIN_SYNC_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Whether the sync setup card should be offered right now. */
export function isLoginSyncPromptDue(state: Pick<BrowserLoginsState, "prompt">): boolean {
  return state.prompt.armedAt !== null && state.prompt.outcome === null;
}
