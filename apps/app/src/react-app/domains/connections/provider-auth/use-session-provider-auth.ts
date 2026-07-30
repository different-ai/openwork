// Session-route wiring for the provider-auth store: a stable store instance
// fed by a latest-values ref, lifecycle (start/dispose), Zen-restriction sync,
// workspace-change resync, the post-onboarding auto-open latch, and cloud
// provider auto-sync. Extracted verbatim from session-route.tsx.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, ProviderListItem, WorkspaceDisplay } from "@/app/types";
import { readDenSettings } from "@/app/lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { reconcilePolicyDisabledProviders } from "@/react-app/domains/connections/policy-provider-reconcile";
import { shouldWaitForCloudProviderSyncBeforePolicyReconcile } from "./managed-models-recovery";
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
  opencodeBaseUrl: string;
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
    opencodeBaseUrl,
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
  const denAuth = useDenAuth();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const reloadCoordinator = useReloadCoordinator();
  const { markReloadRequired } = reloadCoordinator;
  const onboardingProviderAuthPendingRef = useRef(false);
  const policyProviderReconcileInFlightRef = useRef(false);
  const [denSettingsVersion, bumpDenSettingsVersion] = useReducer((value: number) => value + 1, 0);

  const stateRef = useRef({
    opencodeClient,
    opencodeBaseUrl,
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
    opencodeBaseUrl,
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
        providerBaseUrl: () => stateRef.current.opencodeBaseUrl,
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
  useEffect(() => {
    const bump = () => bumpDenSettingsVersion();
    window.addEventListener(denSessionUpdatedEvent, bump);
    window.addEventListener(denSettingsChangedEvent, bump);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, bump);
      window.removeEventListener(denSettingsChangedEvent, bump);
    };
  }, []);

  const cloudProviderSyncContext = useMemo(() => {
    const settings = readDenSettings();
    return {
      client: opencodeClient,
      workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
      workspaceRoot: selectedWorkspaceRoot,
      denBaseUrl: settings.baseUrl,
      activeOrgId: settings.activeOrgId?.trim() ?? "",
      signedIn: denAuth.isSignedIn && Boolean(settings.authToken?.trim()),
    };
  }, [denAuth.isSignedIn, denSettingsVersion, opencodeClient, selectedWorkspaceEndpoint?.workspaceId, selectedWorkspaceRoot]);
  const [completedCloudProviderSync, setCompletedCloudProviderSync] = useState<{
    context: typeof cloudProviderSyncContext;
    providerList: ProviderListResponse | null;
  } | null>(null);
  const currentCloudProviderSync =
    completedCloudProviderSync?.context === cloudProviderSyncContext
      ? completedCloudProviderSync
      : null;
  const cloudProviderSyncReady = Boolean(currentCloudProviderSync);
  const loadCloudProviderSync = useCallback(async (reason: "app_launch" | "manual") => {
    await store.runCloudProviderSync(reason);
    return store.refreshProviders({ force: true });
  }, [store]);
  const refreshCloudProviderSync = useCallback(async (reason: "manual") => {
    const providerList = await loadCloudProviderSync(reason);
    setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });
    return providerList;
  }, [cloudProviderSyncContext, loadCloudProviderSync]);

  useEffect(() => {
    store.start();
    return () => {
      store.dispose();
    };
  }, [store]);

  useEffect(() => {
    if (!opencodeClient || !selectedWorkspaceId) return;
    if (shouldWaitForCloudProviderSyncBeforePolicyReconcile({
      signedIn: cloudProviderSyncContext.signedIn,
      clientConnected: Boolean(cloudProviderSyncContext.client),
      workspaceId: cloudProviderSyncContext.workspaceId,
      activeOrgId: cloudProviderSyncContext.activeOrgId,
      cloudProviderSyncReady,
    })) return;
    if (policyProviderReconcileInFlightRef.current) return;

    policyProviderReconcileInFlightRef.current = true;
    void reconcilePolicyDisabledProviders({
      opencodeClient,
      openworkClient: selectedWorkspaceEndpoint?.client ?? null,
      workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
      workspaceType: selectedWorkspace?.workspaceType ?? null,
      allProviders: providers,
      connectedProviderIds: providerConnectedIds,
      disabledProviderIds,
      checkRestriction: checkDesktopRestriction,
      setDisabledProviders: setDisabledProviderIds,
      markReloadRequired: () => {
        markReloadRequired("config", {
          type: "config",
          name: "opencode.json",
          action: "updated",
        });
      },
    }).catch((error) => {
      console.warn("[desktop-app-restrictions] failed to sync provider restrictions", error);
    }).finally(() => {
      policyProviderReconcileInFlightRef.current = false;
    });
  }, [
    checkDesktopRestriction,
    cloudProviderSyncContext.activeOrgId,
    cloudProviderSyncContext.client,
    cloudProviderSyncContext.signedIn,
    cloudProviderSyncContext.workspaceId,
    cloudProviderSyncReady,
    disabledProviderIds,
    markReloadRequired,
    opencodeClient,
    providerConnectedIds,
    providers,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceEndpoint?.client,
    selectedWorkspaceEndpoint?.workspaceId,
    selectedWorkspaceId,
    setDisabledProviderIds,
  ]);

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
    if (
      !cloudProviderSyncContext.client ||
      !cloudProviderSyncContext.workspaceId ||
      !cloudProviderSyncContext.signedIn ||
      !cloudProviderSyncContext.activeOrgId
    ) return;

    let cancelled = false;
    void loadCloudProviderSync("app_launch").then((providerList) => {
      if (!cancelled) {
        setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cloudProviderSyncContext, loadCloudProviderSync]);

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
    if (store.isProviderAddRestricted()) return;
    void store.openProviderAuthModal({ returnFocusTarget: "composer" });
  }, [selectedWorkspaceEndpoint, store]);

  // Session is where forced sign-in lands. Keep org-managed cloud providers in
  // sync here so sign-in applies opencode.json changes before Settings opens.
  useCloudProviderAutoSync(store.runCloudProviderSync);
  const snapshot = useProviderAuthStoreSnapshot(store);

  return {
    store,
    snapshot,
    cloudProviderSyncReady,
    cloudProviderList: currentCloudProviderSync?.providerList ?? null,
    refreshCloudProviderSync,
  };
}
