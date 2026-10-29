import type { ModelOption, ModelRef } from "@/app/types";
import { managesOwnBehavior, modelSource, modelTitle, nextModelSource, nextPinnedModel, orderedModelPins, MODEL_SOURCE_LABELS } from "@/react-app/domains/models/model-catalog";

export function commandPaletteModelTarget(workbench: { focusedPane: string; secondary: { sessionId: string; draftDestination?: unknown } | null }, primarySessionId: string | null) {
  if (workbench.focusedPane !== "secondary" || !workbench.secondary) return primarySessionId;
  // An unsent side chat has no session yet: like its composer, it uses the new-task model.
  return workbench.secondary.draftDestination ? null : workbench.secondary.sessionId;
}

/**
 * The models the palette lists for its target: the focused composer's own list
 * when it published one, else the route's shared catalog. Never empty just
 * because the focused pane is a side window.
 */
export function commandPaletteModelOptions(published: readonly ModelOption[] | undefined, shared: readonly ModelOption[]): ModelOption[] {
  return [...(published?.length ? published : shared)];
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
    // OpenWork Free and Auto manage their own settings, so they never inherit the previous model's effort.
    const behavior = !managesOwnBehavior(option) && option.behaviorOptions?.some((choice) => choice.value === input.behavior) ? input.behavior : null;
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
  | "models";

export function commandPaletteBackMode(mode: CommandPaletteMode): CommandPaletteMode | null {
  return mode === "root" ? null : "root";
}
