import type { ModelRef } from "../../../../app/types";

export type ModelBehaviorOption = { value: string | null; label: string };

export type ModelControlsStore = {
  selectedSessionModelLabel: string;
  openSessionModelPicker: (options?: {
    returnFocusTarget?: "none" | "composer";
  }) => void;
  sessionModelVariantLabel: string;
  sessionModelVariant: string | null;
  sessionModelBehaviorOptions: ModelBehaviorOption[];
  setSessionModelVariant: (value: string | null) => void;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  autoCompactContext: boolean;
  toggleAutoCompactContext: () => void;
  autoCompactContextBusy: boolean;
  defaultModelVariantLabel: string;
  editDefaultModelVariant: () => void;
};

export type ModelControlsOptions = ModelControlsStore;

// In React the store is constructed externally (via a hook that reads the
// Zustand kernel store + model-config state) and passed to ModelControlsProvider
// as a plain object. We keep this helper so call sites mirror the Solid factory.
export function createModelControlsStore(
  options: ModelControlsOptions,
): ModelControlsStore {
  return options;
}

// Re-export ModelRef so downstream React modules can consume the type without
// reaching back into app/types.
export type { ModelRef };
