/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";

type CloudProviderSyncReason = "sign_in" | "app_resume";
type SyncFn = (reason: CloudProviderSyncReason) => Promise<unknown>;

export function subscribeCloudProviderSyncTriggers(input: {
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  isDocumentVisible: () => boolean;
  sync: (reason: CloudProviderSyncReason) => void;
}) {
  const handleDenSettingsChanged = () => {
    input.sync("sign_in");
  };
  const handleAppResume = () => {
    input.sync("app_resume");
  };
  const handleVisibilityChange = () => {
    if (input.isDocumentVisible()) {
      handleAppResume();
    }
  };

  input.windowTarget.addEventListener(denSettingsChangedEvent, handleDenSettingsChanged);
  input.windowTarget.addEventListener("focus", handleAppResume);
  input.windowTarget.addEventListener("online", handleAppResume);
  input.documentTarget.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    input.windowTarget.removeEventListener(denSettingsChangedEvent, handleDenSettingsChanged);
    input.windowTarget.removeEventListener("focus", handleAppResume);
    input.windowTarget.removeEventListener("online", handleAppResume);
    input.documentTarget.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

/**
 * Event-driven cloud-provider reconciliation. Runs immediately after sign-in,
 * whenever Den settings change (for example active-org selection), and when
 * the user returns to the app or reconnects to the network. Workspace gate
 * transitions and explicit product actions are handled by the provider store.
 *
 * Mount once — the provider store coalesces overlapping triggers.
 */
export function useCloudProviderAutoSync(sync: SyncFn) {
  const denAuth = useDenAuth();
  const syncRef = useRef(sync);

  // Keep the ref current so we always call the latest closure (store
  // identity can change between mounts and we don't want to restart event
  // subscriptions just because the parent re-rendered).
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    if (!denAuth.isSignedIn) return;

    let cancelled = false;

    const tick = async (reason: CloudProviderSyncReason) => {
      if (cancelled) return;
      try {
        await syncRef.current(reason);
      } catch {
        // Network errors, org misconfig, etc. are non-fatal — the next user
        // or lifecycle trigger retries. The refresh function owns surfacing
        // user-visible error state.
      }
    };

    // Immediate pass so users see server state quickly after sign-in.
    void tick("sign_in");

    const unsubscribe = subscribeCloudProviderSyncTriggers({
      windowTarget: window,
      documentTarget: document,
      isDocumentVisible: () => document.visibilityState === "visible",
      sync: (reason) => {
        void tick(reason);
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [denAuth.isSignedIn]);
}
