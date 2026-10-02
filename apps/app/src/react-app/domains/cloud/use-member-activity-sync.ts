/** @jsxImportSource react */
import { useLayoutEffect } from "react";
import { createDenClient, readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";
import { denSessionUpdatedEvent } from "@/app/lib/den-session-events";
import { subscribeProviderCatalogChanges } from "@/app/lib/provider-events";
import { selectActivityContext, useActivityStore } from "@/react-app/kernel/activity-store";
import { ACTIVITY_REFRESH_EVENT, type ActivityScope } from "@/react-app/kernel/activity-types";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { clearCloudInventoryCache, CLOUD_INVENTORY_CHANGED_EVENT } from "@/react-app/domains/connections/cloud-inventory-cache";
import { useDenAuth } from "./den-auth-provider";
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
    const refresh = () => {
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
      const previousEntry = selectActivityContext(useActivityStore.getState()).entries[0]?.id;
      inflight = refreshMemberActivity({ scope, client, feed, isCurrent }).then((result) => {
        if (result === "updated" && isCurrent()
          && selectActivityContext(useActivityStore.getState()).entries[0]?.id !== previousEntry) {
          // Opening a newly available resource must not land in an old cached
          // Library inventory. The in-flight guard coalesces our own signal.
          clearCloudInventoryCache();
        }
      }).finally(() => {
        inflight = null;
      });
    };
    refresh();
    const unsubscribeSync = subscribeCloudProviderSyncTriggers({
      windowTarget: window,
      documentTarget: document,
      isDocumentVisible: () => document.visibilityState === "visible",
      sync: refresh,
    });
    const unsubscribeProviders = subscribeProviderCatalogChanges(refresh);
    window.addEventListener(ACTIVITY_REFRESH_EVENT, refresh);
    window.addEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refresh);
    window.addEventListener(denSessionUpdatedEvent, refresh);
    return () => {
      disposed = true;
      unsubscribeSync();
      unsubscribeProviders();
      window.removeEventListener(ACTIVITY_REFRESH_EVENT, refresh);
      window.removeEventListener(CLOUD_INVENTORY_CHANGED_EVENT, refresh);
      window.removeEventListener(denSessionUpdatedEvent, refresh);
      feed.setScope(null);
    };
  }, [enabled, token, principalId, organizationId, verifiedOrgId, baseUrl]);
}
