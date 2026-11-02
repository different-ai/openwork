import { sameDefaultModel, type DefaultModelChoice, type DefaultModelOption, type DefaultModelOptions } from "@openwork/types/den/default-model";

/** Absence is meaningful only after every source answered successfully. */
export function savedDefaultModelState(input: {
  choice: DefaultModelChoice | null;
  options: DefaultModelOptions | undefined;
  failed: boolean;
  lastKnown?: DefaultModelOption | null;
}) {
  const listed = input.choice ? input.options?.options.find(option => sameDefaultModel(option, input.choice)) : undefined;
  const option = listed ?? (sameDefaultModel(input.lastKnown, input.choice) ? input.lastKnown : null);
  const availability = input.failed || !input.options || input.options.unavailableSources.length > 0
    ? "unknown" : listed ? "listed" : "not-listed";
  return { option, availability, label: option?.modelName ?? "Saved model" };
}
