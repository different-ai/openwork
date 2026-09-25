import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import { getConnectedProviderItems } from "@/react-app/infra/provider-list-query";
import { filterCloudManagedModelOptions, markDisabledModelOptions, mergeModelOptions } from "../connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "../connections/provider-auth/cloud-provider-config";
import { filterEntitledModelOptions, hideBuiltInZenFallback, isProviderAllowedByDesktopPolicy } from "../connections/provider-auth/provider-policy";
import { modelRefKey } from "../session/models/model-collections-store";
import { isAutoModel, withAutoDefaultPin, withImportedModelMetadata, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";

// Every model picker (composer popover, "All models" dialog, command palette,
// shortcuts) reads its options from this pipeline, so they list the same
// models in the same states. It is pure: hooks gather the inputs.

type ProviderList = Parameters<typeof getConnectedProviderItems>[0];

/** A model the engine reports at no cost. Only the built-in Zen fallback rule reads this. */
function costsNothing(model: { cost?: { input?: number; output?: number } }) {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

/** The one place a connected provider's models become picker options. */
export function runtimeModelOptions(data: ProviderList, isNewProvider: (providerId: string) => boolean = () => false): ModelOption[] {
  return getConnectedProviderItems(data).flatMap((provider) => Object.entries(provider.models).map(([id, model]): ModelOption => {
    const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
    const ref = { providerID: provider.id, modelID: id };
    return {
      ...ref, title: model.name || id, description: provider.name,
      behaviorTitle: summary.title, behaviorLabel: summary.label, behaviorDescription: summary.description,
      behaviorValue: summary.value, behaviorOptions: summary.options,
      isFree: isAutoModel(ref) || costsNothing(model),
      ...(isNewProvider(provider.id) ? { isRecommended: true } : {}),
      ...(isCloudManagedProviderKey(provider.id) ? { source: "cloud" as const } : {}),
    };
  }));
}

export type ModelCatalogInput = {
  /** The engine's options; null until its provider list has loaded. */
  runtime: readonly ModelOption[] | null;
  /** Organization-assigned models, usable before the engine reports them. */
  fallback?: readonly ModelOption[];
  /** Gateway models that wait on the member's own provider sign-in. */
  pending?: readonly ModelOption[];
  imports?: Record<string, CloudImportedProvider>;
  signedIn: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  disabledProviders?: readonly string[];
  gatewayProviderIds?: ReadonlySet<string>;
  /** Den's Auto pin policy, from Auto status. */
  autoStatus?: { providerID: string; modelID: string; defaultPinned?: boolean };
};

export type ModelCatalog = {
  /** Everything the person could have chosen, disabled rows included; used to name a saved choice. */
  known: ModelCatalogOption[];
  /** What the pickers list and allow selecting. */
  options: ModelCatalogOption[];
};

export function buildModelCatalog(input: ModelCatalogInput): ModelCatalog {
  const runtime = input.runtime;
  const fallback = input.fallback ?? [];
  // Organization-assigned models stay listed while the engine catches up with a sync; the engine's own
  // record wins where both exist, and pending sign-in models sit on top.
  const merged = withImportedModelMetadata(mergeModelOptions(input.pending ?? [], mergeModelOptions(runtime ?? [], fallback)), input.imports ?? {})
    .map((option) => input.gatewayProviderIds?.has(option.providerID) ? { ...option, source: "gateway" as const } : option);
  const known = markDisabledModelOptions(filterCloudManagedModelOptions(merged, input.signedIn), input.disabledProviders ?? []);
  const entitled = filterEntitledModelOptions(known, { restrictToCloud: input.restrictToCloud, checkRestriction: input.checkRestriction });
  return { known, options: withAutoDefaultPin(hideBuiltInZenFallback(entitled), input.autoStatus) };
}

/** Auto cannot be switched to from a shortcut or the palette while its access is being synced or is not ready. */
export function withAutoActionState(options: readonly ModelCatalogOption[], auto: { blocked: boolean }): ModelCatalogOption[] {
  return auto.blocked ? options.map((option) => isAutoModel(option) ? { ...option, disabled: true } : option) : [...options];
}

export type RetainedSelectionInput = {
  current: ModelRef;
  catalog: ModelCatalog;
  /** The last option this surface saw for `current` in the same identity scope. */
  remembered?: ModelOption;
  /** A reason a caller already knows, e.g. from the send path. */
  saved?: RetainedModelSelection;
  signedIn: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  catalogState: ModelPickerCatalogState["state"];
  /** A conversation's own model; a new task's untouched starter model is not "saved". */
  sessionScoped: boolean;
};

/** Why the current model is not selectable here, or undefined when it is (or nothing was chosen). */
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
  // The free Zen starter is only hidden from the list once better models exist; it still works, so it is not "unavailable".
  const hiddenZenFallback = Boolean(known && !known.disabled && known.providerID === "opencode" && known.isFree === true);
  if (implicitStarter || (hiddenZenFallback && !policyBlocked && !blockedBySaved)
    || (input.catalogState === "loading" && !policyBlocked && !signedOut)) return undefined;
  return {
    model: current,
    title: signedOut ? undefined : known?.title ?? saved?.title,
    description: signedOut ? undefined : known?.description ?? saved?.description,
    reason: policyBlocked ? "policy" : signedOut ? "signed-out" : saved?.reason ?? (known?.disabled ? "disabled" : "unavailable"),
  };
}

/** A saved choice blocked by policy or a disabled provider is not listed, even if its provider reappears. */
export function withoutBlockedSelection(options: readonly ModelCatalogOption[], retained: RetainedModelSelection | undefined): ModelCatalogOption[] {
  if (!retained || (retained.reason !== "policy" && retained.reason !== "disabled")) return [...options];
  return options.filter((option) => modelRefKey(option) !== modelRefKey(retained.model));
}
