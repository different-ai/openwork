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
import { buildModelCatalog, resolveRetainedSelection, runtimeModelOptions, withAutoActionState, withoutBlockedSelection } from "./catalog";
import { isAutoModel, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";

export type UseModelCatalogInput = {
  client: Client | null;
  baseUrl: string;
  directory?: string;
  /** Whether to load the engine's provider list at all. */
  enabled: boolean;
  /** Refetch each time this becomes true, e.g. when a picker opens. */
  refreshWhen?: boolean;
  fallbackOptions?: readonly ModelOption[];
  /** Whether account-scoped providers may be listed; defaults to the Den sign-in state. */
  cloudProvidersEnabled?: boolean;
  importedProviders?: Record<string, CloudImportedProvider>;
  /** Gateway models that wait on the member's own provider sign-in. */
  pendingOptions?: readonly ModelOption[];
  disabledProviders?: readonly string[];
  gatewayProviderIds?: ReadonlySet<string>;
  /** Marks a provider's models as newly added ("Recently added"). Keep the function stable. */
  isNewProvider?: (providerId: string) => boolean;
  /** The model this surface is choosing for, if any; drives the saved-selection row. */
  current?: ModelRef;
  savedSelection?: RetainedModelSelection;
  sessionScoped?: boolean;
  openWorkModelsSyncing?: boolean;
};

export type ModelCatalogView = {
  /** What to list and allow selecting. */
  options: ModelCatalogOption[];
  /** Everything the person could have chosen here, disabled rows included. */
  knownOptions: ModelCatalogOption[];
  /** `options` with Auto disabled while it cannot run; for the palette and shortcuts, which switch without showing why. */
  actionOptions: ModelCatalogOption[];
  catalogState: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  /** The current model's option when it is selectable, else the last one seen in this identity scope. */
  currentOption?: ModelOption;
  restrictToCloud: boolean;
  /** Whether Auto is (or would be) offered here, so its access status matters. */
  autoVisible: boolean;
  /** The provider list's load error, if the last load failed. */
  error: unknown;
  refetch: () => Promise<unknown>;
};

/**
 * The single entitlement pipeline behind every model picker: engine models,
 * assigned and pending gateway models, organization pins, desktop policy,
 * disabled providers, the Zen fallback rule and Auto's pin and readiness.
 */
export function useModelCatalog(input: UseModelCatalogInput): ModelCatalogView {
  const auth = useDenAuth();
  const signedIn = input.cloudProvidersEnabled ?? auth.isSignedIn;
  const checkRestriction = useCheckDesktopRestriction();
  const providers = useProviderListQuery({ client: input.client, baseUrl: input.baseUrl, directory: input.directory || undefined, enabled: input.enabled && Boolean(input.client) });
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
  const catalog = useMemo(() => buildModelCatalog({
    runtime, fallback: input.fallbackOptions, pending: input.pendingOptions, imports: input.importedProviders,
    signedIn, restrictToCloud, checkRestriction, disabledProviders: input.disabledProviders,
    gatewayProviderIds: input.gatewayProviderIds, autoStatus,
  }), [runtime, input.fallbackOptions, input.pendingOptions, input.importedProviders, signedIn, restrictToCloud, checkRestriction,
    input.disabledProviders, input.gatewayProviderIds, autoStatus]);

  const catalogState: ModelPickerCatalogState = {
    state: providers.isError ? "error" : input.client && input.enabled && providers.isPending ? "loading" : "ready",
    lastVerifiedAt: providers.dataUpdatedAt || undefined,
    refreshing: providers.isFetching,
    onRetry: input.client ? () => refetch() : undefined,
  };

  // Keep naming a model this surface already showed, across refetches, until the identity changes.
  const identityScope = JSON.stringify([input.baseUrl, auth.status, auth.verifiedIdentity]);
  const remembered = useRef<{ scope: string; option: ModelOption } | null>(null);
  const current = input.current;
  const selectable = current ? catalog.options.find((option) => modelRefKey(option) === modelRefKey(current) && !option.disabled) : undefined;
  useEffect(() => { if (selectable) remembered.current = { scope: identityScope, option: selectable }; }, [selectable, identityScope]);
  const rememberedOption = remembered.current?.scope === identityScope ? remembered.current.option : undefined;
  const retainedSelection = current ? resolveRetainedSelection({
    current, catalog, remembered: rememberedOption, saved: input.savedSelection, signedIn,
    restrictToCloud, checkRestriction, catalogState: catalogState.state, sessionScoped: input.sessionScoped ?? false,
  }) : undefined;
  const options = useMemo(() => withoutBlockedSelection(catalog.options, retainedSelection), [catalog.options, retainedSelection?.model.providerID, retainedSelection?.model.modelID, retainedSelection?.reason]);
  const auto = options.find(isAutoModel);
  const autoBlocked = Boolean(input.openWorkModelsSyncing || autoQuery.isError
    || (auto && autoStatus && modelRefKey(autoStatus) === modelRefKey(auto) && autoStatus.state !== "ready"));
  const actionOptions = useMemo(() => withAutoActionState(options, { blocked: autoBlocked }), [options, autoBlocked]);
  const hiddenByChoice = retainedSelection?.reason === "policy" || retainedSelection?.reason === "disabled";

  return {
    options, knownOptions: catalog.known, actionOptions, catalogState, retainedSelection, restrictToCloud,
    currentOption: selectable ?? (current ? catalog.known.find((option) => modelRefKey(option) === modelRefKey(current)) ?? (rememberedOption && modelRefKey(rememberedOption) === modelRefKey(current) ? rememberedOption : undefined) : undefined),
    autoVisible: !hiddenByChoice && (Boolean(auto) || Boolean(current && isAutoModel(current))),
    error: providers.error,
    refetch,
  };
}

/**
 * The one path a picker selection takes: the gateway sign-in gate for models
 * that need the member's own provider login, then the recent-models record,
 * then the caller's commit. `contextKey` cancels a pending sign-in when the
 * surface's target changes.
 */
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
