import { useCallback, useEffect, useMemo } from "react";

import { isElectronRuntime } from "@/app/utils";

import { useDenAuth } from "../cloud/den-auth-provider";
import { isLoginSyncPromptDue, usePersistedBrowserLoginsStore } from "./browser-logins-store";

export function getBrowserLoginsBridge() {
  if (!isElectronRuntime()) return null;
  return window.__OPENWORK_ELECTRON__?.browserLogins ?? null;
}

export type BrowserLoginSyncAccess = {
  /** The built-in browser exists and exposes the sync bridge. */
  available: boolean;
  /** Effective organization or local permission. This does not start sync. */
  policyAllowed: boolean;
  /** An organization policy decides; the local permission is not consulted. */
  managedByOrg: boolean;
  /** The one-time setup offer should be shown in the built-in browser. */
  promptDue: boolean;
  markPromptShown: () => void;
  dismissPrompt: () => void;
  completePrompt: () => void;
};

/**
 * Permission only makes browser login sync available. Configuration and the
 * user's active/paused choice live in the desktop sync service. Whenever
 * permission turns on, the next built-in-browser visit offers setup once.
 */
export function useBrowserLoginSync(): BrowserLoginSyncAccess {
  const denAuth = useDenAuth();
  const prompt = usePersistedBrowserLoginsStore((state) => state.prompt);
  const observeEffectiveAllowed = usePersistedBrowserLoginsStore((state) => state.observeEffectiveAllowed);
  const markPromptShownInStore = usePersistedBrowserLoginsStore((state) => state.markPromptShown);
  const resolvePrompt = usePersistedBrowserLoginsStore((state) => state.resolvePrompt);

  const bridge = getBrowserLoginsBridge();
  const available = bridge !== null;
  const managedByOrg = denAuth.isSignedIn;
  // Managed enablement requires a future trusted main-process policy channel.
  // This PR ships personal Desktop sync only; renderer code can revoke but
  // never assert main-process access.
  const policyAllowed = available && !managedByOrg;

  useEffect(() => {
    if (!bridge) return;
    observeEffectiveAllowed(policyAllowed);
    if (managedByOrg) void bridge.disableForManagedContext();
  }, [bridge, managedByOrg, observeEffectiveAllowed, policyAllowed]);

  const markPromptShown = useCallback(() => markPromptShownInStore(), [markPromptShownInStore]);
  const dismissPrompt = useCallback(() => resolvePrompt("dismissed"), [resolvePrompt]);
  const completePrompt = useCallback(() => resolvePrompt("synced"), [resolvePrompt]);

  return useMemo(() => ({
    available,
    policyAllowed,
    managedByOrg,
    promptDue: available && policyAllowed && isLoginSyncPromptDue({ prompt }),
    markPromptShown,
    dismissPrompt,
    completePrompt,
  }), [available, completePrompt, dismissPrompt, managedByOrg, markPromptShown, policyAllowed, prompt]);
}
