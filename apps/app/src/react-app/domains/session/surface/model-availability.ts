import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import {
  isDesktopProviderBlocked,
  type DesktopAppRestrictionChecker,
} from "@/app/cloud/desktop-app-restrictions";
import type { ModelRef } from "@/app/types";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { isManagedModelAvailabilityPending } from "@/react-app/domains/connections/provider-auth/managed-models-recovery";
import { isModelAvailableInConnectedProviders } from "@/react-app/infra/provider-list-query";

export type ModelUnavailableReason =
  | "provider_blocked"
  | "provider_not_connected"
  | "model_missing";

export type ModelAvailability =
  | { status: "pending" }
  | { status: "available" }
  | { status: "unavailable"; reason: ModelUnavailableReason };

export type ModelAvailabilityResolver = (model: ModelRef | null) => ModelAvailability;

export type ModelAvailabilityContext = {
  workspaceReady: boolean;
  loading: boolean;
  signedIn: boolean;
  cloudProviderSyncReady: boolean;
  openWorkModelsSyncing: boolean;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
  cloudProviderList: ProviderListResponse | null;
  liveProviderSync?: boolean;
  providerList: ProviderListResponse | null | undefined;
};

export function computeModelAvailability(
  model: ModelRef | null | undefined,
  context: ModelAvailabilityContext,
): ModelAvailability {
  if (!context.workspaceReady || context.loading) return { status: "pending" };
  if (!model?.providerID?.trim() || !model.modelID?.trim()) {
    return { status: "pending" };
  }

  const providerId = model.providerID.trim();
  const usesCloudProvider = isCloudManagedProviderKey(providerId);
  if (
    isManagedModelAvailabilityPending({
      signedIn: context.signedIn,
      selectedModelUsesCloudProvider: usesCloudProvider,
      cloudProviderSyncReady: context.cloudProviderSyncReady,
      openWorkModelsSyncing: context.openWorkModelsSyncing,
    })
  ) {
    return { status: "pending" };
  }
  if (usesCloudProvider && !context.cloudProviderSyncReady) return { status: "pending" };

  if (
    isDesktopProviderBlocked({
      providerId,
      checkRestriction: context.checkRestriction,
    })
  ) {
    return { status: "unavailable", reason: "provider_blocked" };
  }

  const providerList = usesCloudProvider && !context.liveProviderSync ? context.cloudProviderList : context.providerList;
  if (!providerList) {
    return { status: "pending" };
  }

  if (
    context.restrictToCloud &&
    !providerList.connected.some((connectedId) => connectedId.trim() === providerId)
  ) {
    return { status: "unavailable", reason: "provider_not_connected" };
  }

  if (!isModelAvailableInConnectedProviders(providerList, model)) {
    return { status: "unavailable", reason: "model_missing" };
  }

  return { status: "available" };
}

export const MODEL_UNAVAILABLE_CONFIRMATION_MS = 1_200;

export type UnavailableConfirmationGate = {
  confirm: (
    model: ModelRef | null | undefined,
    verdict: ModelAvailability,
  ) => ModelAvailability;
  nextRecheckDelay: (nowMs?: number) => number | null;
};

export function createUnavailableConfirmationGate(options?: {
  confirmMs?: number;
  now?: () => number;
}): UnavailableConfirmationGate {
  const confirmMs = options?.confirmMs ?? MODEL_UNAVAILABLE_CONFIRMATION_MS;
  const now = options?.now ?? Date.now;
  const firstDeniedAtByModel = new Map<string, number>();
  const keyOf = (model: ModelRef | null | undefined) =>
    `${model?.providerID?.trim() ?? ""}:${model?.modelID?.trim() ?? ""}`;

  return {
    confirm(model, verdict) {
      const key = keyOf(model);
      if (verdict.status !== "unavailable" || verdict.reason === "provider_blocked") {
        firstDeniedAtByModel.delete(key);
        return verdict;
      }
      const current = now();
      const deniedAt = firstDeniedAtByModel.get(key);
      if (deniedAt === undefined) {
        firstDeniedAtByModel.set(key, current);
        return { status: "pending" };
      }
      if (current - deniedAt < confirmMs) return { status: "pending" };
      return verdict;
    },
    nextRecheckDelay(nowMs) {
      const current = nowMs ?? now();
      let next: number | null = null;
      for (const deniedAt of firstDeniedAtByModel.values()) {
        const remaining = confirmMs - (current - deniedAt);
        if (remaining <= 0) continue;
        next = next === null ? remaining : Math.min(next, remaining);
      }
      return next;
    },
  };
}
