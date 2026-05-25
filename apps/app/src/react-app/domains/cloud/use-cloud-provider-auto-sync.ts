/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import { CLOUD_SYNC_INTERVAL_MS } from "../../../app/cloud/sync/constants";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";

type CloudProviderSyncReason = "sign_in" | "app_launch" | "interval" | "settings_cloud_opened";
type SyncFn = (reason: CloudProviderSyncReason) => Promise<unknown>;

/**
  * Periodic cloud-provider reconciliation, ported from dev #1509 "auto-sync
  * cloud providers". Runs the provided sync function immediately, whenever Den
  * settings change (for example active-org selection), and every
  * `CLOUD_SYNC_INTERVAL_MS` while the Den session is signed-in; suspends while
  * signed-out and lets the provider-auth store own user-visible errors.
 *
 * Mount once (e.g. from the settings route) — the hook is idempotent
 * within a single mount, and avoids overlapping ticks using an in-flight
 * ref guard.
 */
export function useCloudProviderAutoSync(sync: SyncFn) {
  const denAuth = useDenAuth();
  const syncRef = useRef(sync);
  const inFlightRef = useRef(false);

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

    const interval = window.setInterval(() => {
      void tick();
    }, CLOUD_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener(denSettingsChangedEvent, handleDenSettingsChanged);
      window.clearInterval(interval);
    };
  }, [denAuth.isSignedIn]);
}
