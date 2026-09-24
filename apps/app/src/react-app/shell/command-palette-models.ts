import type { ModelBehaviorOption, ModelOption, ModelRef } from "@/app/types";
import { isAutoModel, modelGroups, modelSource, modelTitle, modelSubtitle, nextModelSource, nextPinnedModel, orderedModelPins, MODEL_SOURCE_LABELS } from "@/react-app/domains/models/model-catalog";

export function commandPaletteModelTarget(workbench: { focusedPane: string; secondary: { sessionId: string } | null }, primarySessionId: string | null) {
  return workbench.focusedPane === "secondary" && workbench.secondary ? workbench.secondary.sessionId : primarySessionId;
}

/** Settings has no focused session: palette and modal selections both update the default-model preference. */
export function applyDefaultModelPreference<T extends { defaultModel?: ModelRef | null; modelVariant?: string | null }>(prefs: T, model: ModelRef, behavior?: string | null): T {
  const same = prefs.defaultModel?.providerID === model.providerID && prefs.defaultModel.modelID === model.modelID;
  return { ...prefs, defaultModel: { providerID: model.providerID, modelID: model.modelID }, modelVariant: behavior !== undefined ? behavior : same ? prefs.modelVariant ?? null : null };
}

export type CommandPaletteModelControlsInput = {
  options: readonly ModelOption[];
  current: ModelRef | undefined;
  behavior?: string | null;
  favorites: readonly ModelRef[];
  onSelect: (model: ModelRef, behavior: string | null | undefined, option: ModelOption) => void;
};

export function createCommandPaletteModelControls(input: CommandPaletteModelControlsInput) {
  const pins = orderedModelPins(input.options, input.favorites);
  const nextPin = nextPinnedModel(input.options, input.favorites, input.current ?? null);
  const nextSource = nextModelSource(input.options, pins, input.current ?? null);
  const nextPinnedOption = input.options.find((option) => option.providerID === nextPin?.providerID && option.modelID === nextPin.modelID);
  const cycle = (option: ModelOption | undefined | null) => {
    if (!option || option.disabled) return null;
    const behavior = option.behaviorOptions?.some((choice) => choice.value === input.behavior) ? input.behavior : null;
    input.onSelect({ providerID: option.providerID, modelID: option.modelID }, behavior, option);
    return modelTitle(option);
  };
  return {
    modelOptions: [...input.options],
    selectedModel: input.current,
    selectedModelBehavior: input.behavior,
    onSelectModel: input.onSelect,
    onNextPinnedModel: () => cycle(nextPinnedOption),
    onCycleModelSource: () => cycle(nextSource),
    nextPinnedOption,
    nextSourceOption: nextSource,
    sourceCycleDetail: [...new Set([...pins, ...input.options.filter((option) => !option.disabled)].map(modelSource))]
      .map((source) => MODEL_SOURCE_LABELS[source]).join(" · "),
  };
}

export type CommandPaletteMode =
  | "root"
  | "split-sessions"
  | "accessible-items"
  | "agents"
  | "groups"
  | "models"
  | "model-behavior";

export type CommandPaletteModelItem = {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  searchText: string;
  option: ModelOption;
};

export type CommandPaletteBehaviorItem = {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  searchText: string;
  option: ModelBehaviorOption;
};

function isSameModel(left: ModelRef | undefined, right: ModelRef) {
  return left?.providerID === right.providerID && left.modelID === right.modelID;
}

export function commandPaletteBackMode(mode: CommandPaletteMode): CommandPaletteMode | null {
  if (mode === "root") return null;
  if (mode === "model-behavior") return "models";
  return "root";
}

export function buildCommandPaletteModelItems(
  options: readonly ModelOption[],
  current: ModelRef | undefined,
  favorites: readonly ModelRef[] = [],
  recent: readonly ModelRef[] = [],
): CommandPaletteModelItem[] {
  return modelGroups(options, favorites, recent).flatMap((group) => group.items).map((option) => {
    const provider = option.description?.trim() || option.providerID;
    return {
      id: `model:${option.providerID}:${option.modelID}`,
      title: modelTitle(option),
      detail: isAutoModel(option) ? modelSubtitle(option)
        : [provider, option.modelID, option.organizationPinOrder !== undefined ? "pinned by your org" : null].filter(Boolean).join(" · "),
      meta: isSameModel(current, option) ? "Current" : undefined,
      searchText: `${modelTitle(option)} ${modelSubtitle(option)} ${option.title} ${provider} ${option.providerID} ${option.modelID}`,
      option,
    };
  });
}

export function buildCommandPaletteBehaviorItems(
  model: ModelOption,
  currentModel: ModelRef | undefined,
  currentBehaviorValue: string | null | undefined,
): CommandPaletteBehaviorItem[] {
  const modelIsCurrent = isSameModel(currentModel, model);
  return (model.behaviorOptions ?? []).map((option) => ({
    id: `model-behavior:${model.providerID}:${model.modelID}:${option.value ?? "default"}`,
    title: option.label,
    detail: option.description,
    meta: modelIsCurrent && option.value === currentBehaviorValue ? "Current" : undefined,
    searchText: `${model.behaviorTitle} ${option.label} ${option.description} ${option.value ?? "default"}`,
    option,
  }));
}
