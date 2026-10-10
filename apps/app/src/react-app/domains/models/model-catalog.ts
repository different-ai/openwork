import type { ModelOption, ModelRef } from "@/app/types";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import { modelRefKey, nextFavoriteModel } from "../session/models/model-collections-store";

export type ModelPickerCatalogState = {
  state: "loading" | "ready" | "error";
  lastVerifiedAt?: number;
  refreshing?: boolean;
  onRetry?: () => void | Promise<unknown>;
};
export type RetainedModelSelection = {
  model: ModelRef;
  title?: string;
  description?: string;
  reason: "unavailable" | "policy" | "disabled" | "signed-out";
};
export function retainedModelCopy(reason: RetainedModelSelection["reason"]) {
  switch (reason) {
    case "policy": return { subtitle: "blocked by your organization", detail: "Your organization decides which providers are allowed here." };
    case "disabled": return { subtitle: "disabled in AI providers", detail: "Turn this provider back on in AI providers, or choose another model." };
    case "signed-out": return { subtitle: "sign in to verify access", detail: "Sign in to verify access to your saved model, or choose a connected provider." };
    case "unavailable": return { subtitle: "no longer available here", detail: "Your saved model isn’t available here anymore." };
  }
}
export function nonDefaultModelSummary(model: ModelRef, value: string | null, label: string) {
  return !isAutoModel(model) && value !== null ? label : null;
}

export const AUTO_MODEL_ID = "openai/gpt-6-luna";
export const AUTO_PROVIDER_ID = "openwork-free";
export const EXPLICIT_MODEL_CHOICE_KEY = "openwork.modelChoice.explicit";
export function shouldSelectInitialAuto(input: { available: readonly ModelRef[]; current: ModelRef | null; empty: boolean; explicit: boolean }) {
  return input.empty && !input.explicit && Boolean(starterModel(input.available))
    && (!input.current || (input.current.providerID === "opencode" && input.current.modelID === "big-pickle"));
}
export function markExplicitModelChoice() {
  try { window.localStorage.setItem(EXPLICIT_MODEL_CHOICE_KEY, "1"); } catch {}
}
export type ModelSource = "gateway" | "local" | "organization";
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  gateway: "OpenWork Gateway", local: "Local", organization: "Organization",
};

/** Free Auto, as opposed to the same model served by an organization's OpenWork Models. */
export function isFreeAutoModel(model: ModelRef | null | undefined) {
  return model?.providerID === AUTO_PROVIDER_ID && model.modelID === AUTO_MODEL_ID;
}

/** The organization has OpenWork Models, so its members pick those models instead of free Auto. */
export function freeAutoCoveredByOpenWorkModels(options: readonly (ModelRef & { disabled?: boolean })[]) {
  return options.some((option) => option.providerID === "openwork" && !option.disabled);
}

/** The organization's OpenWork Models serve Auto's model under its own name; members use it instead of free Auto. */
export function openWorkModelsLuna<T extends ModelRef & { disabled?: boolean }>(available: readonly T[]): T | undefined {
  return available.find((model) => model.providerID === "openwork" && model.modelID === AUTO_MODEL_ID && !model.disabled);
}

/** The model a new member starts on: Luna from OpenWork Models when the organization has them, free Auto otherwise. */
export function starterModel<T extends ModelRef & { disabled?: boolean }>(available: readonly T[]): T | undefined {
  return freeAutoCoveredByOpenWorkModels(available) ? openWorkModelsLuna(available) : available.find(isAutoModel);
}

/** A saved free Auto choice moves to Luna from OpenWork Models once the organization has it. */
export function openWorkModelsLunaReplacement<T extends ModelRef & { disabled?: boolean }>(current: ModelRef | null | undefined, available: readonly T[]): T | undefined {
  return isAutoModel(current) ? openWorkModelsLuna(available) : undefined;
}

export function isAutoModel(model: ModelRef | null | undefined) {
  return isFreeAutoModel(model);
}

export function modelSource(model: ModelRef & { source?: ModelOption["source"] }): ModelSource {
  if (isAutoModel(model) || model.providerID === "openwork" || model.source === "gateway" || model.providerID.startsWith("ipr_")) return "gateway";
  if (model.source === "cloud" || model.providerID.startsWith("lpr_")) return "organization";
  return "local";
}

/** Gateway ids (`gwm_…`, `ipr_…`) are long and opaque: never a name a person reads. */
function isOpaqueModelId(value: string) {
  return /^(gwm|ipr)_/.test(value);
}

/** A model's display name: its title, never an opaque gateway id (then "<Provider> model"). */
export function modelTitle(model: ModelRef & { title?: string; description?: string }) {
  if (isAutoModel(model)) return "Auto";
  const name = model.title?.trim() || model.modelID;
  if (!isOpaqueModelId(name)) return name;
  const provider = model.description?.trim();
  return provider ? `${provider} model` : "Model";
}

/** A name safe to show as a value: the public title, never an opaque provider/model id. */
export function publicModelTitle(model: ModelRef & { title?: string }): string | undefined {
  if (isAutoModel(model)) return "Auto";
  const title = model.title?.trim();
  if (!title || title === model.modelID || isOpaqueModelId(title)) return undefined;
  return title;
}

/** The OpenWork Models row's meta line, the same in Settings and the Connect a provider sheet. */
export function autoProviderSubtitle() {
  return "Auto";
}

export function modelSubtitle(model: ModelOption, exhausted = false) {
  if (isAutoModel(model)) return exhausted ? "Limit used up" : "OpenWork picks the model";
  // Gateway models assigned to the member that wait on their own provider sign-in.
  if (model.gatewayAuthorization) return [model.description?.trim(), "Sign-in required"].filter(Boolean).join(" · ");
  return [model.description?.trim(), model.organizationPinOrder !== undefined ? "pinned by your org" : null].filter(Boolean).join(" · ");
}

export function withImportedModelMetadata(options: readonly ModelOption[], imports: Record<string, CloudImportedProvider>) {
  const pins = new Map<string, number>();
  const sources = new Map<string, ModelOption["source"]>();
  for (const provider of Object.values(imports)) {
    sources.set(provider.providerId, provider.source === "openwork_gateway" ? "gateway" : "cloud");
    for (const id of provider.pinnedModelIds ?? []) {
      const key = modelRefKey({ providerID: provider.providerId, modelID: id });
      if (provider.modelIds.includes(id) && !pins.has(key)) pins.set(key, pins.size);
    }
  }
  return options.map((option) => ({ ...option,
    source: sources.get(option.providerID) ?? option.source,
    organizationPinOrder: pins.get(modelRefKey(option)) ?? option.organizationPinOrder,
  }));
}

export type ModelCatalogOption = ModelOption & { defaultPinned?: boolean };
export function withAutoDefaultPin(options: readonly ModelOption[], status?: { providerID: string; modelID: string; defaultPinned?: boolean }): ModelCatalogOption[] {
  return options.map((option) => isAutoModel(option) && status && typeof status.defaultPinned === "boolean" && modelRefKey(option) === modelRefKey(status)
    ? { ...option, defaultPinned: status.defaultPinned } : option);
}

export function immutableModelPin(model: ModelCatalogOption) {
  // Auto is pinned for everyone only when an organization admin pins it; otherwise it pins like any model.
  return (isAutoModel(model) && model.defaultPinned === true) || model.organizationPinOrder !== undefined;
}

export function orderedModelPins(options: readonly ModelCatalogOption[], personal: readonly ModelRef[]) {
  const available = options.filter((option) => !option.disabled);
  const byKey = new Map(available.map((option) => [modelRefKey(option), option]));
  const ordered = [
    ...available.filter((option) => isAutoModel(option) && option.defaultPinned === true),
    ...available.filter((option) => option.organizationPinOrder !== undefined).sort((a, b) => a.organizationPinOrder! - b.organizationPinOrder!),
    ...personal.flatMap((model) => { const option = byKey.get(modelRefKey(model)); return option ? [option] : []; }),
  ];
  return [...new Map(ordered.map((option) => [modelRefKey(option), option])).values()];
}

export function nextPinnedModel(options: readonly ModelOption[], personal: readonly ModelRef[], current: ModelRef | null) {
  return nextFavoriteModel(orderedModelPins(options, personal), current);
}

export function nextModelSource(options: readonly ModelOption[], pins: readonly ModelOption[], current: ModelRef | null) {
  const available = [...pins, ...options].filter((option) => !option.disabled);
  const sources = [...new Set(available.map(modelSource))];
  if (sources.length < 2) return null;
  const source = current ? modelSource(options.find((option) => modelRefKey(option) === modelRefKey(current)) ?? current) : null;
  const index = source ? sources.indexOf(source) : -1;
  const next = sources[(index + 1) % sources.length];
  return available.find((option) => modelSource(option) === next) ?? null;
}

export type ModelGroup = { value: string; items: ModelOption[] };
export function modelGroups(options: readonly ModelOption[], personal: readonly ModelRef[], recent: readonly ModelRef[], query = ""): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const shown = new Set<string>();
  const search = query.trim().toLowerCase();
  const available = options.filter((option) => !option.disabled);
  const add = (value: string, candidates: readonly ModelOption[]) => {
    const items = candidates.filter((option) => {
      const key = modelRefKey(option);
      if (shown.has(key) || (search && !`${modelTitle(option)} ${modelSubtitle(option)} ${key}`.toLowerCase().includes(search))) return false;
      shown.add(key);
      return true;
    });
    if (items.length) groups.push({ value, items });
  };
  add("Pinned", orderedModelPins(available, personal));
  add("Recent", recent.flatMap((model) => available.filter((option) => modelRefKey(option) === modelRefKey(model))));
  add("OpenWork Models", available.filter((option) => option.providerID === "openwork" || option.providerID === AUTO_PROVIDER_ID));
  const providers = [...new Set(available.map((option) => option.providerID))].sort((a, b) => {
    const name = (id: string) => available.find((option) => option.providerID === id)?.description || id;
    return name(a).localeCompare(name(b));
  });
  for (const id of providers) {
    const models = available.filter((option) => option.providerID === id).sort((a, b) => modelTitle(a).localeCompare(modelTitle(b)));
    add(models[0]?.description || id, models);
  }
  return groups;
}

export function isPinModelShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "p" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isCycleModelSourceShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "m" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}
