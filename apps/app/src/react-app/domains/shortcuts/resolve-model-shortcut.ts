import { FAST_VARIANT_PREFIX, fastVariantId } from "@openwork/types/cloud-model-fast";

import type { ModelRef } from "@/app/types";
import type { ModelAvailability, ModelUnavailableReason } from "@/react-app/domains/session/surface/model-availability";

import type { ModelSwitchAction } from "./model-shortcuts-store";

export type ShortcutModelOption = {
  behaviorOptions?: ReadonlyArray<{ value: string | null }>;
  disabled?: boolean;
};

export type ModelShortcutDecision =
  | { kind: "unavailable"; reason: ModelUnavailableReason }
  | { kind: "pending" }
  | { kind: "already_active" }
  | {
      kind: "switch";
      variant: string | null;
      effort: string | null;
      fastApplied: boolean;
      fastSkipped: boolean;
      effortSkipped: boolean;
    };

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
