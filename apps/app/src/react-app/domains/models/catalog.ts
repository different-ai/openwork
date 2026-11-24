import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import { freeAutoSwitchedOff } from "@/app/lib/inference-access";
import { getConnectedProviderItems } from "@/react-app/infra/provider-list-query";
import { filterCloudManagedModelOptions, markDisabledModelOptions, mergeModelOptions } from "../connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "../connections/provider-auth/cloud-provider-config";
import { filterEntitledModelOptions, hideBuiltInZenFallback, isProviderAllowedByDesktopPolicy } from "../connections/provider-auth/provider-policy";
import { modelRefKey } from "../session/models/model-collections-store";
import { freeAutoCoveredByOpenWorkModels, isAutoModel, isFreeAutoModel, withAutoDefaultPin, withImportedModelMetadata, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";

type ProviderList = Parameters<typeof getConnectedProviderItems>[0];

function costsNothing(model: { cost?: { input?: number; output?: number } }) {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

export function runtimeModelOptions(data: ProviderList, isNewProvider: (providerId: string) => boolean = () => false): ModelOption[] {
  return getConnectedProviderItems(data).flatMap((provider) => Object.entries(provider.models).map(([id, model]): ModelOption => {
    const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
    const ref = { providerID: provider.id, modelID: id };
    return {
      ...ref, title: model.name || id, description: provider.name,
      behaviorTitle: summary.title, behaviorLabel: summary.label, behaviorDescription: summary.description,
      behaviorValue: summary.value, behaviorOptions: summary.options,
      isFree: isAutoModel(ref) || costsNothing(model),
      ...(provider.id === "opencode" && provider.source === "custom" && costsNothing(model) ? { zenFallback: true } : {}),
      ...(isNewProvider(provider.id) ? { isRecommended: true } : {}),
      ...(isCloudManagedProviderKey(provider.id) ? { source: "cloud" as const } : {}),
    };
  }));
}

export type ModelCatalogInput = {
  runtime: readonly ModelOption[] | null;
  fallback?: readonly ModelOption[];
  pending?: readonly ModelOption[];
  imports?: Record<string, CloudImportedProvider>;
  signedIn: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  disabledProviders?: readonly string[];
  gatewayProviderIds?: ReadonlySet<string>;
  autoStatus?: { providerID: string; modelID: string; defaultPinned?: boolean; code?: string | null };
  autoPending?: boolean;
};

export type ModelCatalog = {
  known: ModelCatalogOption[];
  options: ModelCatalogOption[];
};

export function buildModelCatalog(input: ModelCatalogInput): ModelCatalog {
  const runtime = input.runtime;
  const fallback = input.fallback ?? [];
  const merged = withImportedModelMetadata(mergeModelOptions(input.pending ?? [], mergeModelOptions(runtime ?? [], fallback)), input.imports ?? {})
    .map((option) => input.gatewayProviderIds?.has(option.providerID) ? { ...option, source: "gateway" as const } : option);
  const known = markDisabledModelOptions(filterCloudManagedModelOptions(merged, input.signedIn), input.disabledProviders ?? []);
  const entitled = filterEntitledModelOptions(known, { restrictToCloud: input.restrictToCloud, checkRestriction: input.checkRestriction });
  const autoHidden = input.autoPending === true || freeAutoSwitchedOff(input.autoStatus);
  const freeAutoCovered = freeAutoCoveredByOpenWorkModels(entitled);
  const offered = entitled.filter((option) => autoHidden ? !isAutoModel(option) : !(freeAutoCovered && isFreeAutoModel(option)));
  const listed = input.restrictToCloud ? offered : hideBuiltInZenFallback(offered);
  return { known, options: withAutoDefaultPin(listed, input.autoStatus) };
}

export function withAutoActionState(options: readonly ModelCatalogOption[], auto: { blocked: boolean }): ModelCatalogOption[] {
  return auto.blocked ? options.map((option) => isAutoModel(option) ? { ...option, disabled: true } : option) : [...options];
}

export type RetainedSelectionInput = {
  current: ModelRef;
  catalog: ModelCatalog;
  remembered?: ModelOption;
  saved?: RetainedModelSelection;
  signedIn: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  catalogState: ModelPickerCatalogState["state"];
  sessionScoped: boolean;
};

export function resolveRetainedSelection(input: RetainedSelectionInput): RetainedModelSelection | undefined {
  const { current } = input;
  if (!current.providerID || !current.modelID) return undefined;
  const key = modelRefKey(current);
  const saved = input.saved && modelRefKey(input.saved.model) === key ? input.saved : undefined;
  const blockedBySaved = saved && (saved.reason === "policy" || saved.reason === "disabled");
  if (!blockedBySaved && input.catalog.options.some((option) => modelRefKey(option) === key && !option.disabled)) return undefined;
  const known = input.catalog.known.find((option) => modelRefKey(option) === key)
    ?? (input.remembered && modelRefKey(input.remembered) === key ? input.remembered : undefined);
  const policyBlocked = !isProviderAllowedByDesktopPolicy({ providerId: current.providerID, restrictToCloud: input.restrictToCloud, checkRestriction: input.checkRestriction });
  const signedOut = !input.signedIn && isCloudManagedProviderKey(current.providerID);
  const implicitStarter = !input.sessionScoped && !known && !saved && current.providerID === "opencode" && current.modelID === "big-pickle";
  const hiddenZenFallback = Boolean(known && !known.disabled && known.zenFallback === true);
  const hiddenFreeAuto = Boolean(known && !known.disabled && isFreeAutoModel(known) && freeAutoCoveredByOpenWorkModels(input.catalog.options));
  if (implicitStarter || ((hiddenZenFallback || hiddenFreeAuto) && !policyBlocked && !blockedBySaved)
    || (input.catalogState === "loading" && !policyBlocked && !signedOut)) return undefined;
  return {
    model: current,
    title: signedOut ? undefined : known?.title ?? saved?.title,
    description: signedOut ? undefined : known?.description ?? saved?.description,
    reason: policyBlocked ? "policy" : signedOut ? "signed-out" : saved?.reason ?? (known?.disabled ? "disabled" : "unavailable"),
  };
}

export function restoringModelOption(input: {
  current: ModelRef | undefined;
  restoring: boolean;
  runtime: readonly ModelOption[] | null;
  fallback?: readonly ModelOption[];
}): ModelOption | undefined {
  const { current } = input;
  if (!input.restoring || !current || !isCloudManagedProviderKey(current.providerID)) return undefined;
  const key = modelRefKey(current);
  return [...(input.runtime ?? []), ...(input.fallback ?? [])].find((option) => modelRefKey(option) === key);
}

export function withoutBlockedSelection(options: readonly ModelCatalogOption[], retained: RetainedModelSelection | undefined): ModelCatalogOption[] {
  if (!retained || (retained.reason !== "policy" && retained.reason !== "disabled")) return [...options];
  return options.filter((option) => modelRefKey(option) !== modelRefKey(retained.model));
}
