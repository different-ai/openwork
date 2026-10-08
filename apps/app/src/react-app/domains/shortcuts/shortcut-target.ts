// What a model shortcut's target is right now, and how to say it. One answer
// for the notice after a key press and the Settings row, built on the picker's
// own saved-selection rules (`resolveRetainedSelection`) and copy
// (`retainedModelCopy`), so a model never reads differently in two places.
//
// Rules (ENG-401):
// - A catalog that has not settled is pending, never unavailable.
// - A catalog that failed to load cannot prove a model is gone, so a model it
//   does not list stays pending (retryable) instead of "unavailable".
// - Auto that is syncing or not ready is "not ready", not blocked.
// - A provider the workspace knows but has no sign-in for is "disconnected",
//   the one case with a direct fix (reconnect) that finishes the switch.
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { ModelRef } from "@/app/types";
import { resolveRetainedSelection } from "@/react-app/domains/models/catalog";
import {
  isAutoModel,
  modelTitle,
  retainedModelCopy,
  type ModelCatalogOption,
  type ModelPickerCatalogState,
  type RetainedModelSelection,
} from "@/react-app/domains/models/model-catalog";
import { modelRefKey } from "@/react-app/domains/session/models/model-collections-store";
import type { ModelUnavailableReason } from "@/react-app/domains/session/surface/model-availability";

export type ShortcutTargetFailure =
  | { kind: "not_ready" }
  | { kind: "disconnected" }
  | { kind: "retained"; reason: RetainedModelSelection["reason"] };

export type ShortcutTarget =
  | { kind: "pending" }
  | { kind: "available"; option: ModelCatalogOption }
  | ShortcutTargetFailure;

export type ShortcutTargetInput = {
  model: ModelRef;
  /** Selectable options with Auto disabled while it cannot run (the catalog's `actionOptions`). */
  actionOptions: readonly ModelCatalogOption[];
  /** Everything the person could have chosen, disabled rows included. */
  knownOptions: readonly ModelCatalogOption[];
  catalogState: ModelPickerCatalogState["state"];
  signedIn: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  /** Providers this workspace knows about but has no sign-in or key for. */
  disconnectedProviderIds: ReadonlySet<string>;
};

export function resolveShortcutTarget(input: ShortcutTargetInput): ShortcutTarget {
  const key = modelRefKey(input.model);
  const option = input.actionOptions.find((entry) => modelRefKey(entry) === key);
  if (option && !option.disabled) return { kind: "available", option };
  if (option && isAutoModel(option)) return { kind: "not_ready" };
  const retained = resolveRetainedSelection({
    current: input.model,
    catalog: { known: [...input.knownOptions], options: [...input.actionOptions] },
    signedIn: input.signedIn,
    restrictToCloud: input.restrictToCloud,
    checkRestriction: input.checkRestriction,
    catalogState: input.catalogState,
    sessionScoped: true,
  });
  if (!retained) {
    // The hidden Zen fallback still runs even though the list leaves it out.
    const known = input.knownOptions.find((entry) => modelRefKey(entry) === key && !entry.disabled);
    return known && input.catalogState !== "loading" ? { kind: "available", option: known } : { kind: "pending" };
  }
  // A failed provider-list load is not evidence the model is gone; policy,
  // sign-out and a disabled provider are still known without it.
  if (retained.reason === "unavailable" && input.catalogState === "error") return { kind: "pending" };
  if (retained.reason === "unavailable" && input.disconnectedProviderIds.has(input.model.providerID)) {
    return { kind: "disconnected" };
  }
  return { kind: "retained", reason: retained.reason };
}

/**
 * The route's availability check (`computeModelAvailability` behind the
 * confirmation gate) is the authority on *whether* a shortcut may switch; the
 * catalog only refines *why*. When the two disagree, the reason still comes
 * from the availability verdict so a denial is never shown without one.
 */
export function shortcutFailure(reason: ModelUnavailableReason, target: ShortcutTarget, providerID: string, disconnected: ReadonlySet<string>): ShortcutTargetFailure {
  if (target.kind === "not_ready" || target.kind === "disconnected" || target.kind === "retained") return target;
  if (reason === "provider_blocked") return { kind: "retained", reason: "policy" };
  if (reason === "provider_not_connected" || disconnected.has(providerID)) return { kind: "disconnected" };
  return { kind: "retained", reason: "unavailable" };
}

export type ShortcutFix = "reconnect" | "providers" | "replace";

export type ShortcutTargetCopy = {
  /** Neutral ink and a lock for policy (DESIGN C5); red only for a model that is gone. */
  tone: "blocked" | "warning" | "error" | "info";
  title: string;
  reason: string;
  fix: { kind: ShortcutFix; label: string } | null;
};

function sentence(text: string) {
  return text ? `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}` : text;
}

export function shortcutTargetName(model: ModelRef, option: { title?: string } | null | undefined, savedTitle?: string) {
  return isAutoModel(model) ? "Auto" : modelTitle({ ...model, title: option?.title || savedTitle });
}

export function shortcutTargetCopy(failure: ShortcutTargetFailure, names: { model: string; provider: string | null }): ShortcutTargetCopy {
  const provider = names.provider?.trim() || null;
  const unavailable = `${names.model} isn’t available`;
  if (failure.kind === "not_ready") {
    return { tone: "info", title: `${names.model} isn’t ready yet`, reason: "Checking access", fix: null };
  }
  if (failure.kind === "disconnected") {
    return {
      tone: "warning",
      title: unavailable,
      reason: `${provider ?? "Provider"} disconnected`,
      fix: { kind: "reconnect", label: provider ? `Reconnect ${provider}` : "Reconnect" },
    };
  }
  const reason = sentence(retainedModelCopy(failure.reason).subtitle);
  switch (failure.reason) {
    case "policy": return { tone: "blocked", title: `${names.model} is blocked`, reason, fix: null };
    case "disabled": return { tone: "info", title: unavailable, reason, fix: { kind: "providers", label: "Open AI providers" } };
    case "signed-out": return { tone: "info", title: unavailable, reason, fix: null };
    case "unavailable": return { tone: "error", title: unavailable, reason, fix: { kind: "replace", label: "Choose a replacement" } };
  }
}
