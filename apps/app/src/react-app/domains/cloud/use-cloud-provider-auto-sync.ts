/** @jsxImportSource react */
import { useEffect, useRef } from "react";

import { CLOUD_SYNC_INTERVAL_MS } from "../../../app/cloud/sync/constants";
import { useDenAuth } from "./den-auth-provider";

type RefreshFn = (options?: { force?: boolean }) => Promise<unknown>;

/**
 * Periodic cloud-provider refresh, ported from dev #1509 "auto-sync cloud
 * providers". Calls the provided `refreshCloudOrgProviders` every
 * `CLOUD_SYNC_INTERVAL_MS` while the Den session is signed-in; suspends
 * while signed-out and runs an immediate tick when auth flips back on.
 *
 * Mount once (e.g. from the settings route) — the hook is idempotent
 * within a single mount, and avoids overlapping ticks using an in-flight
 * ref guard.
 */
export function useCloudProviderAutoSync(refresh: RefreshFn) {
  const denAuth = useDenAuth();
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef(false);

  // Keep the ref current so we always call the latest closure (store
  // identity can change between mounts and we don't want to restart the
  // timer just because the parent re-rendered).
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!denAuth.isSignedIn) return;

    let cancelled = false;

    const tick = async () => {
      if (inFlightRef.current || cancelled) return;
      inFlightRef.current = true;
      try {
        await refreshRef.current({ force: true });
      } catch {
        // Network errors, org misconfig, etc. are non-fatal — we'll try
        // again on the next interval. The refresh function owns surfacing
        // any user-visible error state.
      } finally {
        inFlightRef.current = false;
      }
    };

    // Immediate pass so users see server state quickly after sign-in.
    void tick();

    const interval = window.setInterval(() => {
      void tick();
    }, CLOUD_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [denAuth.isSignedIn]);
}
