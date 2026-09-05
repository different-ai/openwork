import type { ModelBehaviorOption, ModelOption, ModelRef } from "@/app/types";

export type CommandPaletteMode =
  | "root"
  | "sessions"
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
): CommandPaletteModelItem[] {
  return options.map((option) => {
    const provider = option.description?.trim() || option.providerID;
    return {
      id: `model:${option.providerID}:${option.modelID}`,
      title: option.title,
      detail: `${provider} · ${option.modelID}`,
      meta: isSameModel(current, option) ? "Current" : undefined,
      searchText: `${option.title} ${provider} ${option.providerID} ${option.modelID}`,
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
