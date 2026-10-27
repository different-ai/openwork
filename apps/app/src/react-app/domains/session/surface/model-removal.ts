import type { ModelOption, ModelRef } from "@/app/types";
import { modelMakerId, modelGroups, modelTitle } from "@/react-app/domains/models/model-catalog";
import { modelRefKey } from "../models/model-collections-store";

export type RemovalInventory = {
  models: readonly ModelRef[];
  lockedModels: readonly ModelRef[];
};

/** Two successful, independent member inventory reads are required. Unknown is not removed. */
export function confirmedOrganizationRemoval(input: {
  model: ModelRef;
  before: RemovalInventory | null;
  after: RemovalInventory | null;
  engineSettled: boolean;
  engineMissing: boolean;
}): boolean {
  const key = modelRefKey(input.model);
  const absent = (inventory: RemovalInventory | null) => inventory !== null
    && ![...inventory.models, ...inventory.lockedModels].some((model) => modelRefKey(model) === key);
  return input.engineSettled && input.engineMissing && absent(input.before) && absent(input.after);
}

/** Same maker beats shortcuts, even when a gateway hides that maker behind opaque IDs. */
export function closestAvailableModel(
  options: readonly ModelOption[], personal: readonly ModelRef[], recent: readonly ModelRef[],
  unavailable: ModelRef & { title?: string }, usable: (model: ModelOption) => boolean,
): ModelOption | null {
  const shortcuts = [...personal, ...recent].flatMap((ref) => {
    const option = options.find((candidate) => modelRefKey(candidate) === modelRefKey(ref));
    return option ? [option] : [];
  });
  const ordered = [...shortcuts, ...modelGroups(options, [], []).flatMap((group) => group.items)];
  const candidates = [...new Map(ordered.map((option) => [modelRefKey(option), option])).values()]
    .filter((option) => !option.disabled && modelRefKey(option) !== modelRefKey(unavailable) && !option.gatewayAuthorization && usable(option));
  const maker = modelMakerId(unavailable);
  const family = candidates.filter((option) => maker
    ? modelMakerId(option) === maker
    : !/^(ipr|lpr)_/.test(unavailable.providerID) && option.providerID === unavailable.providerID);
  // For Claude, preserve the closest tier instead of jumping from Opus to Haiku.
  const tier = (model: ModelRef & { title?: string }) => {
    const name = modelTitle(model).toLowerCase();
    return name.includes("opus") ? 3 : name.includes("sonnet") ? 2 : name.includes("haiku") ? 1 : 0;
  };
  family.sort((left, right) => Math.abs(tier(left) - tier(unavailable)) - Math.abs(tier(right) - tier(unavailable)));
  return family[0] ?? candidates[0] ?? null;
}
