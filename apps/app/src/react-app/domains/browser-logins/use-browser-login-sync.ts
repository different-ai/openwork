import { useCallback, useEffect, useMemo } from "react";

import { isElectronRuntime } from "@/app/utils";

import { useDesktopConfig } from "../cloud/desktop-config-provider";
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
  /** The user's permission on an unmanaged install. */
  localAllowed: boolean;
  setLocalAllowed: (allowed: boolean) => void;
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
  const { config, freshConfigStatus } = useDesktopConfig();
  const denAuth = useDenAuth();
  const managedValue = config.allowBrowserLoginSync;
  const localAllowed = usePersistedBrowserLoginsStore((state) => state.localAllowed);
  const prompt = usePersistedBrowserLoginsStore((state) => state.prompt);
  const setLocalAllowed = usePersistedBrowserLoginsStore((state) => state.setLocalAllowed);
  const observeEffectiveAllowed = usePersistedBrowserLoginsStore((state) => state.observeEffectiveAllowed);
  const markPromptShownInStore = usePersistedBrowserLoginsStore((state) => state.markPromptShown);
  const resolvePrompt = usePersistedBrowserLoginsStore((state) => state.resolvePrompt);

  const bridge = getBrowserLoginsBridge();
  const available = bridge !== null;
  const managedByOrg = denAuth.isSignedIn;
  // Login sync never trusts a cached org grant. A revocation made while the
  // app was closed must stop reads until a fresh policy response says yes.
  const policyAllowed = managedByOrg
    ? freshConfigStatus === "ready" && managedValue === true
    : localAllowed;

  useEffect(() => {
    if (!bridge) return;
    observeEffectiveAllowed(policyAllowed);
    void bridge.setPolicyAllowed(policyAllowed);
  }, [bridge, observeEffectiveAllowed, policyAllowed]);

  const markPromptShown = useCallback(() => markPromptShownInStore(), [markPromptShownInStore]);
  const dismissPrompt = useCallback(() => resolvePrompt("dismissed"), [resolvePrompt]);
  const completePrompt = useCallback(() => resolvePrompt("synced"), [resolvePrompt]);

  return useMemo(() => ({
    available,
    policyAllowed,
    managedByOrg,
    localAllowed,
    setLocalAllowed,
    promptDue: available && policyAllowed && isLoginSyncPromptDue({ prompt }),
    markPromptShown,
    dismissPrompt,
    completePrompt,
  }), [available, completePrompt, dismissPrompt, localAllowed, managedByOrg, markPromptShown, policyAllowed, prompt, setLocalAllowed]);
}
