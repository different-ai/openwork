import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { Client } from "@/app/types";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import { updateManagedDisabledProviders } from "./managed-engine-config";
import { isProviderAllowedByDesktopPolicy } from "./provider-auth/provider-policy";

export const POLICY_DISABLED_PROVIDERS_STORAGE_KEY = "openwork.policy.disabledProviders";

export type PolicyProviderListItem = {
  id: string;
};

export type ComputePolicyProviderReconcilePlanInput = {
  allProviders: readonly PolicyProviderListItem[];
  connectedProviderIds: readonly string[];
  disabledProviderIds: readonly string[];
  markedDisabledProviderIds: readonly string[];
  checkRestriction: DesktopAppRestrictionChecker;
};

export type PolicyProviderReconcilePlan = {
  toDisable: string[];
  toReenable: string[];
  nextMarkedDisabledProviderIds: string[];
};

type PolicyDisabledProvidersStorage = Pick<Storage, "getItem" | "setItem">;

export type ReconcilePolicyDisabledProvidersInput = {
  opencodeClient: Client | null;
  openworkClient?: OpenworkServerClient | null;
  workspaceId?: string | null;
  workspaceType?: string | null;
  allProviders: readonly PolicyProviderListItem[];
  connectedProviderIds: readonly string[];
  disabledProviderIds: readonly string[];
  checkRestriction: DesktopAppRestrictionChecker;
  storage?: PolicyDisabledProvidersStorage | null;
  setDisabledProviders?: (providerIds: string[]) => void;
  markReloadRequired?: () => void;
};

export type ReconcilePolicyDisabledProvidersResult = PolicyProviderReconcilePlan & {
  disabledProviderIds: string[];
  markedDisabledProviderIds: string[];
  writes: number;
};

function normalizeProviderIds(values: readonly unknown[]): string[] {
  const providerIds: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const providerId = value.trim();
    if (providerId && !providerIds.includes(providerId)) providerIds.push(providerId);
  }
  return providerIds;
}

function sameProviderIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function addProviderId(providerIds: readonly string[], providerId: string) {
  return providerIds.includes(providerId) ? [...providerIds] : [...providerIds, providerId];
}

function removeProviderId(providerIds: readonly string[], providerId: string) {
  return providerIds.filter((id) => id !== providerId);
}

function defaultPolicyDisabledProviderStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readPolicyDisabledProviderIds(
  storage: PolicyDisabledProvidersStorage | null | undefined = defaultPolicyDisabledProviderStorage(),
) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(POLICY_DISABLED_PROVIDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeProviderIds(parsed) : [];
  } catch {
    return [];
  }
}

export function writePolicyDisabledProviderIds(
  providerIds: readonly string[],
  storage: PolicyDisabledProvidersStorage | null | undefined = defaultPolicyDisabledProviderStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(
      POLICY_DISABLED_PROVIDERS_STORAGE_KEY,
      JSON.stringify(normalizeProviderIds(providerIds)),
    );
  } catch {
    // Storage failures should not block policy enforcement.
  }
}

export function computePolicyProviderReconcilePlan(
  input: ComputePolicyProviderReconcilePlanInput,
): PolicyProviderReconcilePlan {
  const restrictToCloud = input.checkRestriction({ restriction: "allowCustomProviders" });
  const allProviderIds = normalizeProviderIds(input.allProviders.map((provider) => provider.id));
  const knownProviderIds = new Set(allProviderIds);
  const connectedProviderIds = normalizeProviderIds(input.connectedProviderIds).filter(
    (providerId) => knownProviderIds.size === 0 || knownProviderIds.has(providerId),
  );
  const disabledProviderIds = normalizeProviderIds(input.disabledProviderIds);
  const markedDisabledProviderIds = normalizeProviderIds(input.markedDisabledProviderIds);
  const disabledSet = new Set(disabledProviderIds);

  const isAllowed = (providerId: string) =>
    isProviderAllowedByDesktopPolicy({
      providerId,
      restrictToCloud,
      checkRestriction: input.checkRestriction,
    });

  const toDisable = connectedProviderIds.filter(
    (providerId) => !disabledSet.has(providerId) && !isAllowed(providerId),
  );
  const toReenable = markedDisabledProviderIds.filter(
    (providerId) => disabledSet.has(providerId) && isAllowed(providerId),
  );
  const toReenableSet = new Set(toReenable);
  const staleMarkedSet = new Set(
    markedDisabledProviderIds.filter(
      (providerId) => !disabledSet.has(providerId) && isAllowed(providerId),
    ),
  );
  const nextMarkedDisabledProviderIds = markedDisabledProviderIds.filter(
    (providerId) => !toReenableSet.has(providerId) && !staleMarkedSet.has(providerId),
  );
  for (const providerId of toDisable) {
    if (!nextMarkedDisabledProviderIds.includes(providerId)) {
      nextMarkedDisabledProviderIds.push(providerId);
    }
  }

  return { toDisable, toReenable, nextMarkedDisabledProviderIds };
}

export async function reconcilePolicyDisabledProviders(
  input: ReconcilePolicyDisabledProvidersInput,
): Promise<ReconcilePolicyDisabledProvidersResult> {
  const storage = input.storage === undefined ? defaultPolicyDisabledProviderStorage() : input.storage;
  let disabledProviderIds = normalizeProviderIds(input.disabledProviderIds);
  let markedDisabledProviderIds = readPolicyDisabledProviderIds(storage);
  let writes = 0;

  const initialPlan = computePolicyProviderReconcilePlan({
    allProviders: input.allProviders,
    connectedProviderIds: input.connectedProviderIds,
    disabledProviderIds,
    markedDisabledProviderIds,
    checkRestriction: input.checkRestriction,
  });

  for (const providerId of initialPlan.toDisable) {
    if (disabledProviderIds.includes(providerId)) continue;
    const result = await updateManagedDisabledProviders({
      opencodeClient: input.opencodeClient,
      openworkClient: input.openworkClient,
      workspaceId: input.workspaceId,
      workspaceType: input.workspaceType,
      disabledProviders: addProviderId(disabledProviderIds, providerId),
      removeFallbackKeyWhenEmpty: true,
      markReloadRequired: input.markReloadRequired,
    });
    disabledProviderIds = result.disabledProviders;
    input.setDisabledProviders?.(disabledProviderIds);
    markedDisabledProviderIds = addProviderId(markedDisabledProviderIds, providerId);
    writePolicyDisabledProviderIds(markedDisabledProviderIds, storage);
    writes += 1;
  }

  for (const providerId of initialPlan.toReenable) {
    markedDisabledProviderIds = removeProviderId(markedDisabledProviderIds, providerId);
    if (!disabledProviderIds.includes(providerId)) {
      writePolicyDisabledProviderIds(markedDisabledProviderIds, storage);
      continue;
    }
    const result = await updateManagedDisabledProviders({
      opencodeClient: input.opencodeClient,
      openworkClient: input.openworkClient,
      workspaceId: input.workspaceId,
      workspaceType: input.workspaceType,
      disabledProviders: removeProviderId(disabledProviderIds, providerId),
      removeFallbackKeyWhenEmpty: true,
      markReloadRequired: input.markReloadRequired,
    });
    disabledProviderIds = result.disabledProviders;
    input.setDisabledProviders?.(disabledProviderIds);
    writePolicyDisabledProviderIds(markedDisabledProviderIds, storage);
    writes += 1;
  }

  const finalPlan = computePolicyProviderReconcilePlan({
    allProviders: input.allProviders,
    connectedProviderIds: input.connectedProviderIds,
    disabledProviderIds,
    markedDisabledProviderIds,
    checkRestriction: input.checkRestriction,
  });

  if (!sameProviderIds(markedDisabledProviderIds, finalPlan.nextMarkedDisabledProviderIds)) {
    markedDisabledProviderIds = finalPlan.nextMarkedDisabledProviderIds;
    writePolicyDisabledProviderIds(markedDisabledProviderIds, storage);
  }

  return {
    ...finalPlan,
    disabledProviderIds,
    markedDisabledProviderIds,
    writes,
  };
}
