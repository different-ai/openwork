// Decide what pressing a model shortcut does. Pure so every branch is tested.
//
// Rules (ENG-398 / ENG-401 / ENG-406):
// - An unavailable model never changes the current model and never removes
//   the shortcut; the caller shows the reason and one fix.
// - A catalog that has not settled is pending, never unavailable.
// - Reasoning and Fast are preferences: when the model does not offer them the
//   switch still happens at the provider default / standard speed, and the
//   caller says so.
import { FAST_VARIANT_PREFIX, fastVariantId } from "@openwork/types/cloud-model-fast";

import type { ModelRef } from "@/app/types";
import type { ModelAvailability, ModelUnavailableReason } from "@/react-app/domains/session/surface/model-availability";

import type { ModelSwitchAction } from "./model-shortcuts-store";

export type ShortcutModelOption = {
  behaviorOptions?: ReadonlyArray<{ value: string | null }>;
  /** The picker shows this option but will not select it right now (e.g. Auto while its allowance is blocked). */
  disabled?: boolean;
};

export type ModelShortcutDecision =
  | { kind: "unavailable"; reason: ModelUnavailableReason }
  | { kind: "pending" }
  | { kind: "already_active" }
  | {
      kind: "switch";
      variant: string | null;
      /** Standard reasoning level that was applied (null: provider default). */
      effort: string | null;
      /** Fast was requested and applied. */
      fastApplied: boolean;
      /** Fast was requested but the model does not offer it right now. */
      fastSkipped: boolean;
      /** A reasoning level was requested but the model does not offer it. */
      effortSkipped: boolean;
    };

/** Resolve a saved {effort, fast} preference to a variant the model offers. */
export function resolveShortcutVariant(
  values: ReadonlyArray<string | null>,
  effort: string | null,
  fast: boolean,
) {
  const offered = new Set(values);
  const effortApplied = effort !== null && !effort.startsWith(FAST_VARIANT_PREFIX) && offered.has(effort)
    ? effort
    : null;
  const fastCandidate = fastVariantId(effortApplied);
  const fastApplied = fast && offered.has(fastCandidate);
  return {
    variant: fastApplied ? fastCandidate : effortApplied,
    effort: effortApplied,
    fastApplied,
    fastSkipped: fast && !fastApplied,
    effortSkipped: effort !== null && effortApplied === null,
  };
}

export function decideModelShortcut(input: {
  action: ModelSwitchAction;
  option: ShortcutModelOption | null;
  availability: ModelAvailability;
  current: { model: ModelRef | null; variant: string | null };
}): ModelShortcutDecision {
  const { action, option, availability, current } = input;
  if (availability.status === "unavailable") return { kind: "unavailable", reason: availability.reason };
  if (availability.status === "pending") return { kind: "pending" };
  if (!option) return { kind: "unavailable", reason: "model_missing" };
  if (option.disabled) return { kind: "unavailable", reason: "provider_blocked" };

  const values = (option.behaviorOptions ?? []).map((entry) => entry.value);
  const resolved = resolveShortcutVariant(values, action.effort, action.fast);
  const sameModel = current.model?.providerID === action.providerID && current.model.modelID === action.modelID;
  if (sameModel && current.variant === resolved.variant) return { kind: "already_active" };
  return { kind: "switch", ...resolved };
}
