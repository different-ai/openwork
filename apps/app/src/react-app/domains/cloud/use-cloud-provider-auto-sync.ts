/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import { CLOUD_SYNC_INTERVAL_MS } from "../../../app/cloud/sync/constants";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useDenAuth } from "./den-auth-provider";

export type CloudProviderSyncReason = "sign_in" | "app_launch" | "interval" | "settings_cloud_opened";
type SyncFn = (reason: CloudProviderSyncReason) => Promise<unknown>;

export function createCloudProviderSyncRunner(sync: SyncFn) {
  let cancelled = false;
  let pendingReason: CloudProviderSyncReason | null = null;
  let drainPromise: Promise<void> | null = null;

  const drain = async () => {
    while (!cancelled && pendingReason) {
      const reason = pendingReason;
      pendingReason = null;
      try {
        await sync(reason);
      } catch {
        // The owning store surfaces user-visible errors. A failed pass still
        // releases the runner so a newer settings state can reconcile.
      }
    }
  };

  return {
    request(reason: CloudProviderSyncReason = "interval"): Promise<void> {
      if (cancelled) return Promise.resolve();
      pendingReason = reason;
      if (!drainPromise) {
        drainPromise = drain().finally(() => {
          drainPromise = null;
        });
      }
      return drainPromise;
    },
    cancel() {
      cancelled = true;
      pendingReason = null;
    },
  };
}

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

  // Keep the ref current so we always call the latest closure (store
  // identity can change between mounts and we don't want to restart the
  // timer just because the parent re-rendered).
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    if (!denAuth.isSignedIn) return;

    const runner = createCloudProviderSyncRunner((reason) => syncRef.current(reason));

    // Immediate pass so users see server state quickly after sign-in.
    void runner.request("sign_in");

    const handleDenSettingsChanged = () => {
      void runner.request("sign_in");
    };
    window.addEventListener(denSettingsChangedEvent, handleDenSettingsChanged);

    const interval = window.setInterval(() => {
      void runner.request();
    }, CLOUD_SYNC_INTERVAL_MS);

    return () => {
      runner.cancel();
      window.removeEventListener(denSettingsChangedEvent, handleDenSettingsChanged);
      window.clearInterval(interval);
    };
  }, [denAuth.isSignedIn]);
}
