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
import {
  shouldWaitForCloudProviderSyncBeforePolicyReconcile,
  type OrganizationModelsRefreshReason,
} from "./managed-models-recovery";
import { createSessionOpenworkServer, type SessionServerEndpoint } from "./session-openwork-server";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";
import { useLiveProviderSync } from "./use-live-provider-sync";
import { resyncAfterGatewaySignIn, skipsLegacyProviderRefresh } from "./live-provider-sync";

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
  engineRootServer?: SessionServerEndpoint | null;
  localServerHostToken?: string;
  localServerGeneration?: number | null;
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
    engineRootServer,
    localServerHostToken,
    localServerGeneration,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  } = input;
  const denAuth = useDenAuth();
  const liveProviderSync = useLiveProviderSync(
    selectedWorkspaceEndpoint?.client ?? engineRootServer?.client ?? null,
    opencodeBaseUrl,
  );
  const liveProviderSyncRef = useRef(liveProviderSync);
  liveProviderSyncRef.current = liveProviderSync;
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
    engineRootServer,
    localServerHostToken,
    localServerGeneration,
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
    engineRootServer,
    localServerHostToken,
    localServerGeneration,
  };

  const store = useMemo(
    () =>
      createProviderAuthStore({
        nativeOpenworkClient: () => stateRef.current.selectedWorkspaceEndpoint?.client ?? null,
        nativeWorkspaceId: () => stateRef.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
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
        openworkServer: createSessionOpenworkServer({
          endpoint: () => stateRef.current.selectedWorkspaceEndpoint ?? stateRef.current.engineRootServer ?? null,
          hostToken: () => stateRef.current.localServerHostToken ?? "",
          generation: () => stateRef.current.localServerGeneration ?? null,
        }),
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
      engineRoot: Boolean(engineRootServer),
      workspaceRoot: selectedWorkspaceRoot,
      denBaseUrl: settings.baseUrl,
      activeOrgId: settings.activeOrgId?.trim() ?? "",
      signedIn: denAuth.isSignedIn && Boolean(settings.authToken?.trim()),
    };
  }, [denAuth.isSignedIn, denSettingsVersion, engineRootServer, opencodeClient, selectedWorkspaceEndpoint?.workspaceId, selectedWorkspaceRoot]);
  const [completedCloudProviderSync, setCompletedCloudProviderSync] = useState<{
    context: typeof cloudProviderSyncContext;
    providerList: ProviderListResponse | null;
  } | null>(null);
  const currentCloudProviderSync =
    completedCloudProviderSync?.context === cloudProviderSyncContext
      ? completedCloudProviderSync
      : null;
  const cloudProviderSyncReady = Boolean(currentCloudProviderSync);
  const loadCloudProviderSync = useCallback(async (reason: OrganizationModelsRefreshReason) => {
    const result = await store.runCloudProviderSync(reason);
    if (liveProviderSyncRef.current || result?.outcome === "handled_live") return null;
    return store.refreshProviders({ force: true });
  }, [store]);
  const refreshCloudProviderSync = useCallback(async (reason: OrganizationModelsRefreshReason) => {
    if (skipsLegacyProviderRefresh(reason, liveProviderSyncRef.current)) return null;
    const providerList = await loadCloudProviderSync(reason);
    setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });
    return providerList;
  }, [cloudProviderSyncContext, loadCloudProviderSync]);
  const resyncGatewaySignIn = useCallback(() => resyncAfterGatewaySignIn({
    runSync: () => store.runCloudProviderSync("manual", { refreshGatewayCatalog: true }),
    refreshProviders: async () => {
      const providerList = await store.refreshProviders({ force: true });
      if (!liveProviderSyncRef.current) setCompletedCloudProviderSync({ context: cloudProviderSyncContext, providerList });
    },
    gatewayUsageProviderScope: () => store.getSnapshot().gatewayUsageProviderScope,
  }), [cloudProviderSyncContext, store]);

  useEffect(() => { store.syncFromOptions(); }, [store]);

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
    localServerHostToken,
    localServerGeneration,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceEndpoint?.baseUrl,
    selectedWorkspaceEndpoint?.token,
    selectedWorkspaceEndpoint?.workspaceId,
    selectedWorkspaceRoot,
    engineRootServer?.baseUrl,
    store,
  ]);

  useEffect(() => {
    if (
      !cloudProviderSyncContext.client ||
      !(cloudProviderSyncContext.workspaceId || cloudProviderSyncContext.engineRoot) ||
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

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
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

  useCloudProviderAutoSync(refreshCloudProviderSync);
  const snapshot = useProviderAuthStoreSnapshot(store);

  return {
    store,
    snapshot,
    cloudProviderSyncReady,
    cloudProviderList: liveProviderSync ? null : currentCloudProviderSync?.providerList ?? null,
    refreshCloudProviderSync,
    resyncGatewaySignIn,
    liveProviderSync,
  };
}
