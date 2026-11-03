/** @jsxImportSource react */
import { useLayoutEffect } from "react";
import { createDenClient, readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";
import { denSessionUpdatedEvent } from "@/app/lib/den-session-events";
import { subscribeProviderCatalogChanges } from "@/app/lib/provider-events";
import { selectActivityContext, useActivityStore } from "@/react-app/kernel/activity-store";
import { ACTIVITY_REFRESH_EVENT, type ActivityScope } from "@/react-app/kernel/activity-types";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import {
  clearCloudInventoryCache,
  CLOUD_INVENTORY_CHANGED_EVENT,
  readCloudInventoryScope,
  storeCloudInventory,
} from "@/react-app/domains/connections/cloud-inventory-cache";
import { noteInventoryRevision, reconcileMemberAccess, trackMemberAccessCheck } from "@/react-app/domains/dashboard/mcp-app-member-access";
import { useDenAuth } from "./den-auth-provider";
import { createInventoryRevisionGate } from "./inventory-revision";
import { subscribeCloudProviderSyncTriggers } from "./use-cloud-provider-auto-sync";
import { refreshMemberActivity } from "./member-activity-sync";

/** One app-level observer using the same lifecycle triggers as desktop cloud sync. */
export function useMemberActivitySync(enabled: boolean) {
  const { verifiedIdentity } = useDenAuth();
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  const baseUrl = resolveDenBaseUrls(settings).apiBaseUrl;
  const principalId = verifiedIdentity?.principalId;
  const verifiedOrgId = verifiedIdentity?.organizationId;

  useLayoutEffect(() => {
    const feed = useActivityStore.getState();
    if (!enabled || !token || !principalId || organizationId !== verifiedOrgId) {
      feed.setScope(null);
      return;
    }
    const scope: ActivityScope = { baseUrl, organizationId, memberId: principalId };
    feed.setScope(scope);
    let disposed = false;
    let inflight: Promise<unknown> | null = null;
    const isCurrent = () => {
      const current = readDenSettings();
      return !disposed
        && current.authToken?.trim() === token
        && current.activeOrgId?.trim() === organizationId
        && resolveDenBaseUrls(current).apiBaseUrl === baseUrl;
    };
    const client = createDenClient({ baseUrl, apiBaseUrl: baseUrl, token, requireCompleteInventory: true });
    const gate = createInventoryRevisionGate();
    /** "check" (app resume, timer) skips the reload while Den's inventory revision is unchanged. */
    const refresh = (trigger: "check" | "now" = "now") => {
      if (!isCurrent()) {
        // Invalidate immediately, before React finishes verifying the next account.
        disposed = true;
        feed.setScope(null);
        useNotificationStore.setState((state) => ({
          notifications: state.notifications.filter((entry) => entry.kind !== "cloud" && entry.kind !== "providers"),
        }));
        return;
      }
      if (inflight) return;
      inflight = (async () => {
        const { skip, revision } = await gate.check();
        if (!isCurrent()) return;
        noteInventoryRevision(scope, revision);
        if (trigger === "check" && skip) return;
        const previousEntry = selectActivityContext(useActivityStore.getState()).entries[0]?.id;
        const loaded: { value: Parameters<typeof storeCloudInventory>[1] | null } = { value: null };
        const result = await refreshMemberActivity({
          scope, client, feed, isCurrent,
          onLoaded: (value) => { loaded.value = value; },
        });
        if (result !== "updated" || !isCurrent()) return;
        gate.synced(revision);
        if (loaded.value) reconcileMemberAccess(scope, revision, loaded.value);
        const changed = selectActivityContext(useActivityStore.getState()).entries[0]?.id !== previousEntry;
        const cacheScope = readCloudInventoryScope();
        if (loaded.value && cacheScope?.organizationId === organizationId) {
          // The composer and Settings reuse this complete inventory instead of
          // fetching it again. The in-flight guard coalesces our own signal.
          storeCloudInventory(cacheScope, loaded.value, { changed });
        } else if (changed) {
          // Opening a newly available resource must not land in an old cached
          // Library inventory.
          clearCloudInventoryCache();
        }
      })().finally(() => {
        inflight = null;
      });
      trackMemberAccessCheck(inflight);
    };
    const refreshNow = () => refresh("now");
    refresh("now");
    const unsubscribeSync = subscribeCloudProviderSyncTriggers({
      windowTarget: window,
      documentTarget: document,
      isDocumentVisible: () => document.visibilityState === "visible",
      sync: (reason) => refresh(reason === "sign_in" ? "now" : "check"),
    });
    const unsubscribeProviders = subscribeProviderCatalogChanges(refreshNow);
    window.addEventListener(ACTIVITY_REFRESH_EVENT, refreshNow);
    window.addEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refreshNow);
    window.addEventListener(denSessionUpdatedEvent, refreshNow);
    return () => {
      disposed = true;
      unsubscribeSync();
      unsubscribeProviders();
      window.removeEventListener(ACTIVITY_REFRESH_EVENT, refreshNow);
      window.removeEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refreshNow);
      window.removeEventListener(denSessionUpdatedEvent, refreshNow);
      feed.setScope(null);
    };
  }, [enabled, token, principalId, organizationId, verifiedOrgId, baseUrl]);
}
