import { AUTO_ROUTER_PROVIDER_ID, autoRouterIdFromModel } from "@openwork/types/den/auto-router";
import { FAST_DEFAULT_VARIANT } from "@openwork/types/cloud-model-fast";
import { getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
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
  return !managesOwnBehavior(model) && value !== null ? label : null;
}

export function modelTriggerSettings(input: {
  model: ModelRef;
  named: boolean;
  verified: boolean;
  options: readonly { value: string | null; label: string; description?: string }[];
  value: string | null;
}): { summary: string | null; fast: boolean } {
  if (!input.named || managesOwnBehavior(input.model)) return { summary: null, fast: false };
  const selection = getModelBehaviorSelection(input.options, input.value);
  const controls = getModelBehaviorControls(selection.options, selection.value);
  if (controls.fast) {
    return { fast: true, summary: input.value === FAST_DEFAULT_VARIANT ? null : controls.options.find((option) => option.value === input.value)?.label ?? null };
  }
  const listed = selection.options.some((option) => option.value === input.value);
  return { fast: false, summary: listed || input.verified ? nonDefaultModelSummary(input.model, input.value, selection.label) : null };
}

export const AUTO_MODEL_ID = "openai/gpt-6-luna";
export const AUTO_PROVIDER_ID = "openwork-free";
export const FREE_MODEL_NAME = "OpenWork Free";
export const FREE_MODEL_ENGINE_TITLE = "GPT-6 Luna";
export const AUTO_ROUTER_GROUP = "Smart";
export const SMART_MODEL_FALLBACK_NAME = "Smart";

export function isAutoRouterModel(model: ModelRef | null | undefined) {
  return model?.providerID === AUTO_ROUTER_PROVIDER_ID;
}

export function managesOwnBehavior(model: ModelRef | null | undefined) {
  return isAutoModel(model) || isAutoRouterModel(model);
}
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

export function isFreeAutoModel(model: ModelRef | null | undefined) {
  return model?.providerID === AUTO_PROVIDER_ID && model.modelID === AUTO_MODEL_ID;
}

export function freeAutoCoveredByOpenWorkModels(options: readonly (ModelRef & { disabled?: boolean })[]) {
  return options.some((option) => option.providerID === "openwork" && !option.disabled);
}

export function openWorkModelsLuna<T extends ModelRef & { disabled?: boolean }>(available: readonly T[]): T | undefined {
  return available.find((model) => model.providerID === "openwork" && model.modelID === AUTO_MODEL_ID && !model.disabled);
}

export function starterModel<T extends ModelRef & { disabled?: boolean }>(available: readonly T[]): T | undefined {
  return freeAutoCoveredByOpenWorkModels(available) ? openWorkModelsLuna(available) : available.find(isAutoModel);
}

export function openWorkModelsLunaReplacement<T extends ModelRef & { disabled?: boolean }>(current: ModelRef | null | undefined, available: readonly T[]): T | undefined {
  return isAutoModel(current) ? openWorkModelsLuna(available) : undefined;
}

export function isAutoModel(model: ModelRef | null | undefined) {
  return isFreeAutoModel(model);
}

export function fixedModelTitle(model: ModelRef & { title?: string }): string | undefined {
  if (isAutoModel(model)) return model.title?.trim() && model.title.trim() !== model.modelID ? undefined : FREE_MODEL_ENGINE_TITLE;
  if (isAutoRouterModel(model)) {
    const title = model.title?.trim();
    return title && title !== model.modelID && autoRouterIdFromModel(title) === null ? title : undefined;
  }
  return undefined;
}

export function modelSource(model: ModelRef & { source?: ModelOption["source"] }): ModelSource {
  if (isAutoModel(model) || isAutoRouterModel(model) || model.providerID === "openwork" || model.source === "gateway" || model.providerID.startsWith("ipr_")) return "gateway";
  if (model.source === "cloud" || model.providerID.startsWith("lpr_")) return "organization";
  return "local";
}

function isOpaqueModelId(value: string) {
  return /^(gwm|ipr)_/.test(value);
}

export function modelTitle(model: ModelRef & { title?: string; description?: string }) {
  const fixed = fixedModelTitle(model);
  if (fixed) return fixed;
  if (isAutoRouterModel(model)) return SMART_MODEL_FALLBACK_NAME;
  const name = model.title?.trim() || model.modelID;
  if (!isOpaqueModelId(name)) return name;
  const provider = model.description?.trim();
  return provider ? `${provider} model` : "Model";
}

export function publicModelTitle(model: ModelRef & { title?: string }): string | undefined {
  const fixed = fixedModelTitle(model);
  if (fixed) return fixed;
  if (isAutoRouterModel(model)) return SMART_MODEL_FALLBACK_NAME;
  const title = model.title?.trim();
  if (!title || title === model.modelID || isOpaqueModelId(title)) return undefined;
  return title;
}

export function autoProviderSubtitle() {
  return FREE_MODEL_NAME;
}

const MODEL_MAKERS: readonly [RegExp, string][] = [
  [/\bclaude\b/, "anthropic"], [/\b(gpt|codex|o[1-9])(\b|-|\d)/, "openai"], [/\b(gemini|gemma)\b/, "google"],
  [/\bgrok\b/, "xai"], [/\bllama\b/, "meta"], [/\b(mistral|codestral|devstral|magistral)\b/, "mistral"], [/\bdeepseek\b/, "deepseek"],
];

export function modelMakerId(model: ModelRef & { title?: string }): string | null {
  const text = `${model.title ?? ""} ${model.modelID}`.toLowerCase();
  return MODEL_MAKERS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function modelStateLabel(model: ModelOption): string | null {
  if (model.gatewayAuthorization) return "Sign-in required";
  if (model.organizationPinOrder !== undefined) return "Pinned by your org";
  return null;
}

export function modelSubtitle(model: ModelOption) {
  if (isAutoRouterModel(model)) return "Picks the best model for each task";
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
  const add = (value: string, candidates: readonly ModelOption[], claim = true) => {
    const items = candidates.filter((option) => {
      const key = modelRefKey(option);
      if (shown.has(key) || (search && !`${modelTitle(option)} ${modelSubtitle(option)} ${key}`.toLowerCase().includes(search))) return false;
      if (claim) shown.add(key);
      return true;
    });
    if (items.length) groups.push({ value, items });
  };
  add(AUTO_ROUTER_GROUP, available.filter(isAutoRouterModel)
    .sort((a, b) => modelTitle(a).localeCompare(modelTitle(b)) || a.modelID.localeCompare(b.modelID)));
  add("Pinned", orderedModelPins(available, personal));
  add("Recent", recent.flatMap((model) => available.filter((option) => modelRefKey(option) === modelRefKey(model))), false);
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

export function nextAvailableModel(
  options: readonly ModelOption[],
  personal: readonly ModelRef[],
  recent: readonly ModelRef[],
  unavailable: ModelRef,
  usable: (model: ModelOption) => boolean = () => true,
): ModelOption | null {
  const skip = modelRefKey(unavailable);
  return modelGroups(options, personal, recent).flatMap((group) => group.items)
    .find((option) => modelRefKey(option) !== skip && usable(option)) ?? null;
}

export function isPinModelShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "p" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isCycleModelSourceShortcut(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  return event.key.toLowerCase() === "m" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}
