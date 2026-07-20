// Session-route wiring for the provider-auth store: a stable store instance
// fed by a latest-values ref, lifecycle (start/dispose), Zen-restriction sync,
// workspace-change resync, the post-onboarding auto-open latch, and cloud
// provider auto-sync. Extracted verbatim from session-route.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem, WorkspaceDisplay } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";

const emptyWorkspaceDisplay: WorkspaceDisplay = {
  id: "",
  name: "",
  path: "",
  preset: "default",
  workspaceType: "local",
};

export type UseSessionProviderAuthInput = {
  opencodeClient: Client | null;
  providers: ProviderListItem[];
  providerDefaults: Record<string, string>;
  providerConnectedIds: string[];
  disabledProviderIds: string[];
  selectedWorkspace: RouteWorkspace | null | undefined;
  selectedWorkspaceEndpoint: ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceRoot: string;
  selectedWorkspaceId: string;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviderIds: (value: string[]) => void;
};

export function useSessionProviderAuth(input: UseSessionProviderAuthInput) {
  const {
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
    selectedWorkspaceId,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  } = input;
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const reloadCoordinator = useReloadCoordinator();
  const { markReloadRequired } = reloadCoordinator;
  const onboardingProviderAuthPendingRef = useRef(false);

  const stateRef = useRef({
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  });
  stateRef.current = {
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  };

  // Depend on the stable callback, not the coordinator object: the context
  // value identity changes on every reload flip, and recreating this store
  // triggers a spurious cloud provider sync pass that amplified the
  // dispose/create loop.
  const store = useMemo(
    () =>
      createProviderAuthStore({
        client: () => stateRef.current.opencodeClient,
        providers: () => stateRef.current.providers,
        providerDefaults: () => stateRef.current.providerDefaults,
        providerConnectedIds: () => stateRef.current.providerConnectedIds,
        disabledProviders: () => stateRef.current.disabledProviderIds,
        checkDesktopAppRestriction: checkDesktopRestriction,
        selectedWorkspaceDisplay: () =>
          stateRef.current.selectedWorkspace
            ? ({
                ...stateRef.current.selectedWorkspace,
                name: workspaceLabel(stateRef.current.selectedWorkspace),
              } as WorkspaceDisplay)
            : emptyWorkspaceDisplay,
        selectedWorkspaceRoot: () => stateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => stateRef.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
        openworkServer: {
          getSnapshot: () => ({
            openworkServerStatus: stateRef.current.selectedWorkspaceEndpoint ? "connected" : "disconnected",
            openworkServerClient: stateRef.current.selectedWorkspaceEndpoint?.client ?? null,
            openworkServerCapabilities: stateRef.current.selectedWorkspaceEndpoint
              ? {
                  config: { read: true, write: true },
                }
              : null,
          }),
        },
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders: setDisabledProviderIds,
        markOpencodeConfigReloadRequired: () => {
          markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [checkDesktopRestriction, markReloadRequired],
  );
  const cloudProviderSyncContext = useMemo(() => ({
    client: opencodeClient,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    workspaceRoot: selectedWorkspaceRoot,
  }), [opencodeClient, selectedWorkspaceEndpoint?.workspaceId, selectedWorkspaceRoot]);
  const [completedCloudProviderSync, setCompletedCloudProviderSync] = useState<{
    context: typeof cloudProviderSyncContext;
    providerList: ProviderListResponse | null;
  } | null>(null);

  useEffect(() => {
    store.start();
    return () => {
      store.dispose();
    };
  }, [store]);

  useEffect(() => {
    if (!opencodeClient || !selectedWorkspaceId) return;

    void store
      .ensureProjectProviderDisabledState(
        "opencode",
        checkDesktopRestriction({ restriction: "allowZenModel" }),
      )
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [checkDesktopRestriction, disabledProviderIds, opencodeClient, selectedWorkspaceId, selectedWorkspaceRoot, store]);

  useEffect(() => {
    store.syncFromOptions();
  }, [
    opencodeClient,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceEndpoint?.workspaceId,
    selectedWorkspaceRoot,
    store,
  ]);

  useEffect(() => {
    if (!cloudProviderSyncContext.client || !cloudProviderSyncContext.workspaceId) return;

    let cancelled = false;
    void (async () => {
      await store.runCloudProviderSync("app_launch");
      const providerList = await store.refreshProviders({ force: true });
      if (!cancelled) {
        setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudProviderSyncContext, store]);

  // After onboarding, auto-open the provider modal if no providers are connected.
  // The welcome route appends ?onboarding=1 to the session URL after workspace creation.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
    // Strip the param so it doesn't re-trigger.
    window.location.hash = hash.replace(/[?&]onboarding=1/, "");
    onboardingProviderAuthPendingRef.current = true;
  }, []);

  useEffect(() => {
    if (!onboardingProviderAuthPendingRef.current) return;
    if (!selectedWorkspaceEndpoint) return;
    onboardingProviderAuthPendingRef.current = false;
    store.openProviderAuthModal({ returnFocusTarget: "composer" });
  }, [selectedWorkspaceEndpoint, store]);

  // Session is where forced sign-in lands. Keep org-managed cloud providers in
  // sync here so sign-in applies opencode.json changes before Settings opens.
  useCloudProviderAutoSync(store.runCloudProviderSync);
  const snapshot = useProviderAuthStoreSnapshot(store);
  const currentCloudProviderSync =
    completedCloudProviderSync?.context === cloudProviderSyncContext
      ? completedCloudProviderSync
      : null;

  return {
    store,
    snapshot,
    cloudProviderSyncReady: Boolean(currentCloudProviderSync),
    cloudProviderList: currentCloudProviderSync?.providerList ?? null,
  };
}
