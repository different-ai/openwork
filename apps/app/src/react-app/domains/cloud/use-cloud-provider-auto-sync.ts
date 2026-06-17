/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import {
  CLOUD_FOCUS_SYNC_MIN_INTERVAL_MS,
  CLOUD_SYNC_INTERVAL_MS,
} from "../../../app/cloud/sync/constants";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";

type CloudProviderSyncReason =
  | "sign_in"
  | "app_launch"
  | "interval"
  | "settings_cloud_opened"
  | "window_focus";
type SyncFn = (reason: CloudProviderSyncReason) => Promise<unknown>;

/**
  * Periodic cloud-provider reconciliation, ported from dev #1509 "auto-sync
  * cloud providers". Runs the provided sync function immediately, whenever Den
  * settings change (for example active-org selection), every
  * `CLOUD_SYNC_INTERVAL_MS` while the Den session is signed-in, and when the
  * window regains focus/visibility so models added in the web admin appear
  * without waiting for the next interval; suspends while signed-out and lets
  * the provider-auth store own user-visible errors.
  *
  * Mount once (e.g. from the settings route) — the hook is idempotent
  * within a single mount, and avoids overlapping ticks using an in-flight
  * ref guard.
  */
export function useCloudProviderAutoSync(sync: SyncFn) {
  const denAuth = useDenAuth();
  const syncRef = useRef(sync);
  const inFlightRef = useRef(false);
  const lastFocusSyncAtRef = useRef(0);

  // Keep the ref current so we always call the latest closure (store
  // identity can change between mounts and we don't want to restart the
  // timer just because the parent re-rendered).
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    if (!denAuth.isSignedIn) return;

    let cancelled = false;

    const tick = async (reason: CloudProviderSyncReason = "interval") => {
      if (inFlightRef.current || cancelled) return;
      inFlightRef.current = true;
      try {
        await syncRef.current(reason);
      } catch {
        // Network errors, org misconfig, etc. are non-fatal — we'll try
        // again on the next interval. The refresh function owns surfacing
        // any user-visible error state.
      } finally {
        inFlightRef.current = false;
      }
    };

    // Immediate pass so users see server state quickly after sign-in.
    void tick("sign_in");

    const handleDenSettingsChanged = () => {
      void tick("sign_in");
    };
    window.addEventListener(denSettingsChangedEvent, handleDenSettingsChanged);

    // When the user returns to the app (window focused or made visible again),
    // reconcile cloud providers so models added in the web admin appear
    // without waiting up to the full interval. Throttled so rapid blur/focus
    // cycles don't hammer the Den API; the in-flight guard and the store's
    // sync queue dedup concurrent runs on top of this.
    const handleReturnToApp = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusSyncAtRef.current < CLOUD_FOCUS_SYNC_MIN_INTERVAL_MS) return;
      lastFocusSyncAtRef.current = now;
      void tick("window_focus");
    };
    window.addEventListener("focus", handleReturnToApp);
    document.addEventListener("visibilitychange", handleReturnToApp);

    const interval = window.setInterval(() => {
      void tick();
    }, CLOUD_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener(denSettingsChangedEvent, handleDenSettingsChanged);
      window.removeEventListener("focus", handleReturnToApp);
      document.removeEventListener("visibilitychange", handleReturnToApp);
      window.clearInterval(interval);
    };
  }, [denAuth.isSignedIn]);
}
