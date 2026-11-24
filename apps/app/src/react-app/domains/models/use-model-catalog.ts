import { freeAutoSwitchedOff } from "@/app/lib/inference-access";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { Client, ModelOption, ModelRef } from "@/app/types";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useAutoAccess } from "@/react-app/domains/cloud/auto-access-ui";
import { useGatewayModelSelection } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
import { useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { modelRefKey, useModelCollectionsStore } from "../session/models/model-collections-store";
import { buildModelCatalog, resolveRetainedSelection, restoringModelOption, runtimeModelOptions, withAutoActionState, withoutBlockedSelection } from "./catalog";
import { isAutoModel, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";

export type UseModelCatalogInput = {
  client: Client | null;
  baseUrl: string;
  directory?: string;
  enabled: boolean;
  refreshWhen?: boolean;
  fallbackOptions?: readonly ModelOption[];
  cloudProvidersEnabled?: boolean;
  importedProviders?: Record<string, CloudImportedProvider>;
  pendingOptions?: readonly ModelOption[];
  disabledProviders?: readonly string[];
  gatewayProviderIds?: ReadonlySet<string>;
  isNewProvider?: (providerId: string) => boolean;
  current?: ModelRef;
  savedSelection?: RetainedModelSelection;
  sessionScoped?: boolean;
  openWorkModelsSyncing?: boolean;
};

export type ModelCatalogView = {
  options: ModelCatalogOption[];
  knownOptions: ModelCatalogOption[];
  actionOptions: ModelCatalogOption[];
  catalogState: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  currentOption?: ModelOption;
  restoring: boolean;
  restrictToCloud: boolean;
  autoVisible: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

export function providerListLoadState(input: {
  isError: boolean;
  isPending: boolean;
  isPlaceholderData: boolean;
  active: boolean;
}): ModelPickerCatalogState["state"] {
  if (input.isError) return "error";
  if (input.isPlaceholderData || (input.active && input.isPending)) return "loading";
  return "ready";
}

export function useModelCatalog(input: UseModelCatalogInput): ModelCatalogView {
  const auth = useDenAuth();
  const signedIn = input.cloudProvidersEnabled ?? auth.isSignedIn;
  const checkRestriction = useCheckDesktopRestriction();
  const providers = useProviderListQuery({ client: input.client, baseUrl: input.baseUrl, directory: input.directory || undefined, enabled: input.enabled && Boolean(input.client), showSavedWhileLoading: true });
  const refetch = providers.refetch;
  useEffect(() => {
    if (input.refreshWhen && input.client) void refetch();
  }, [input.refreshWhen, input.client, refetch]);
  useEffect(() => {
    if (!input.client) return;
    const refresh = () => { void refetch(); };
    window.addEventListener(newProvidersEvent, refresh);
    return () => window.removeEventListener(newProvidersEvent, refresh);
  }, [input.client, refetch]);

  const runtime = useMemo(() => providers.data?.all ? runtimeModelOptions(providers.data, input.isNewProvider) : null, [providers.data, input.isNewProvider]);
  const restrictToCloud = checkRestriction({ restriction: "allowCustomProviders" });
  const autoPresent = Boolean(runtime?.some(isAutoModel) || input.fallbackOptions?.some(isAutoModel) || (input.current && isAutoModel(input.current)));
  const { query: autoQuery } = useAutoAccess(autoPresent);
  const autoStatus = autoQuery.data;
  const autoPending = autoPresent && autoQuery.isPending && autoQuery.fetchStatus !== "idle";
  const catalog = useMemo(() => buildModelCatalog({
    runtime, fallback: input.fallbackOptions, pending: input.pendingOptions, imports: input.importedProviders,
    signedIn, restrictToCloud, checkRestriction, disabledProviders: input.disabledProviders,
    gatewayProviderIds: input.gatewayProviderIds, autoStatus, autoPending,
  }), [runtime, input.fallbackOptions, input.pendingOptions, input.importedProviders, signedIn, restrictToCloud, checkRestriction,
    input.disabledProviders, input.gatewayProviderIds, autoStatus, autoPending]);

  const catalogState: ModelPickerCatalogState = {
    state: providerListLoadState({ ...providers, active: Boolean(input.client) && input.enabled }),
    lastVerifiedAt: providers.dataUpdatedAt || undefined,
    refreshing: providers.isFetching,
    onRetry: input.client ? () => refetch() : undefined,
  };

  const identityScope = JSON.stringify([input.baseUrl, auth.status, auth.verifiedIdentity]);
  const remembered = useRef<{ scope: string; option: ModelOption } | null>(null);
  const current = input.current;
  const selectable = current ? catalog.options.find((option) => modelRefKey(option) === modelRefKey(current) && !option.disabled) : undefined;
  useEffect(() => { if (selectable) remembered.current = { scope: identityScope, option: selectable }; }, [selectable, identityScope]);
  const rememberedOption = remembered.current?.scope === identityScope ? remembered.current.option : undefined;
  const retainedSelection = current ? resolveRetainedSelection({
    current, catalog, remembered: rememberedOption, saved: input.savedSelection, signedIn,
    restrictToCloud, checkRestriction, sessionScoped: input.sessionScoped ?? false,
    catalogState: autoPending && isAutoModel(current) ? "loading" : catalogState.state,
  }) : undefined;
  const options = useMemo(() => withoutBlockedSelection(catalog.options, retainedSelection), [catalog.options, retainedSelection?.model.providerID, retainedSelection?.model.modelID, retainedSelection?.reason]);
  const auto = options.find(isAutoModel);
  const autoBlocked = Boolean(input.openWorkModelsSyncing);
  const actionOptions = useMemo(() => withAutoActionState(options, { blocked: autoBlocked }), [options, autoBlocked]);
  const hiddenByChoice = retainedSelection?.reason === "policy" || retainedSelection?.reason === "disabled";
  const restoring = auth.status === "checking" && !signedIn;
  const restoringOption = restoringModelOption({ current, restoring, runtime, fallback: input.fallbackOptions });

  return {
    options, knownOptions: catalog.known, actionOptions, catalogState, retainedSelection, restrictToCloud,
    currentOption: selectable ?? (current ? catalog.known.find((option) => modelRefKey(option) === modelRefKey(current)) ?? (rememberedOption && modelRefKey(rememberedOption) === modelRefKey(current) ? rememberedOption : undefined) : undefined) ?? restoringOption,
    restoring,
    autoVisible: !freeAutoSwitchedOff(autoStatus) && !hiddenByChoice && (Boolean(auto) || Boolean(current && isAutoModel(current))),
    error: providers.error,
    refetch,
  };
}

export function useModelChoice(contextKey: string) {
  const gateway = useGatewayModelSelection(contextKey);
  const select = gateway.select;
  const choose = useCallback((option: ModelOption, commit: () => void) => {
    if (option.disabled) return;
    select(option, () => {
      useModelCollectionsStore.getState().recordRecent(option);
      commit();
    });
  }, [select]);
  return { choose, loginOpen: gateway.loginOpen, pendingOptions: gateway.options, disabledProviders: gateway.disabledProviders };
}
