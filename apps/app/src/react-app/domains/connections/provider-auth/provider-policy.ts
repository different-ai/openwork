import { isLocalModelProviderId } from "@openwork/types/den/desktop-policies";
import {
  DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
  isDesktopProviderBlocked,
  type DesktopAppRestrictionChecker,
} from "@/app/cloud/desktop-app-restrictions";
import type { ModelOption, ModelRef } from "@/app/types";
import { isCloudManagedProviderKey } from "./cloud-provider-config";

export type ProviderDesktopPolicyInput = {
  providerId: string;
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
};

export type ProviderAddRestrictionInput = {
  providerId?: string | null;
  checkRestriction: DesktopAppRestrictionChecker;
};

export type FilterEntitledModelOptionsInput = {
  restrictToCloud: boolean;
  checkRestriction: DesktopAppRestrictionChecker;
};

export type ModelEntitlementOption = Pick<ModelOption, "providerID" | "modelID"> & {
  disabled?: boolean;
};

export function isProviderAllowedByDesktopPolicy(input: ProviderDesktopPolicyInput) {
  const providerId = input.providerId.trim();
  if (!providerId) return false;

  if (
    isDesktopProviderBlocked({
      providerId,
      checkRestriction: input.checkRestriction,
    })
  ) {
    return false;
  }

  if (!input.restrictToCloud) return true;
  if (isCloudManagedProviderKey(providerId)) return true;
  if (isLocalModelProviderId(providerId)) return true;
  return providerId.toLowerCase() === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID;
}

export function isProviderAddRestrictedByDesktopPolicy(input: ProviderAddRestrictionInput) {
  const restrictToCloud = input.checkRestriction({ restriction: "allowCustomProviders" });
  if (!restrictToCloud) return false;

  const providerId = input.providerId?.trim() ?? "";
  if (!providerId) return true;

  return !isProviderAllowedByDesktopPolicy({
    providerId,
    restrictToCloud,
    checkRestriction: input.checkRestriction,
  });
}

const BUILT_IN_ZEN_PROVIDER_ID = "opencode";

export function isKeylessZenProvider(provider: { id: string; source?: string }) {
  return provider.id.trim().toLowerCase() === BUILT_IN_ZEN_PROVIDER_ID && provider.source === "custom";
}

export function keylessProviderIds(providers: ReadonlyArray<{ id: string; source?: string }>): ReadonlySet<string> {
  return new Set(providers.filter(isKeylessZenProvider).map((provider) => provider.id));
}

export function hideBuiltInZenFallback<T extends Pick<ModelOption, "providerID"> & { zenFallback?: boolean }>(options: readonly T[]): T[] {
  const fallback = (option: T) => option.providerID === BUILT_IN_ZEN_PROVIDER_ID && option.zenFallback === true;
  return options.some((option) => !fallback(option)) ? options.filter((option) => !fallback(option)) : [...options];
}

export function filterEntitledModelOptions<T extends Pick<ModelOption, "providerID"> & { disabled?: boolean }>(
  options: readonly T[],
  input: FilterEntitledModelOptionsInput,
): T[] {
  return options.filter((option) => {
    if (option.disabled) return false;
    return isProviderAllowedByDesktopPolicy({
      providerId: option.providerID,
      restrictToCloud: input.restrictToCloud,
      checkRestriction: input.checkRestriction,
    });
  });
}

export function resolveEntitledOrgDefaultModel(
  options: readonly ModelEntitlementOption[],
  input: FilterEntitledModelOptionsInput & { currentDefault: ModelRef | null },
): ModelRef | null {
  const entitled = filterEntitledModelOptions(options, input);
  if (
    input.currentDefault &&
    (isCloudManagedProviderKey(input.currentDefault.providerID) || entitled.some(
      (option) =>
        option.providerID === input.currentDefault?.providerID &&
        option.modelID === input.currentDefault.modelID,
    ))
  ) {
    return null;
  }

  const replacement = entitled.find((option) => isCloudManagedProviderKey(option.providerID));
  return replacement
    ? { providerID: replacement.providerID, modelID: replacement.modelID }
    : null;
}

export type OrgDefaultModelReplacementInput = FilterEntitledModelOptionsInput & {
  currentDefault: ModelRef | null;
  runtimeOptions: readonly ModelEntitlementOption[];
  runtimeCatalogPending: boolean;
  assignedOptions: readonly ModelEntitlementOption[];
};

export function resolveOrgDefaultModelReplacement(
  input: OrgDefaultModelReplacementInput,
): ModelRef | null {
  if (input.runtimeCatalogPending) return null;
  return resolveEntitledOrgDefaultModel(
    input.runtimeOptions.length > 0 ? input.runtimeOptions : input.assignedOptions,
    input,
  );
}
