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
    entitled.some(
      (option) =>
        option.providerID === input.currentDefault?.providerID &&
        option.modelID === input.currentDefault.modelID,
    )
  ) {
    return null;
  }

  const replacement = entitled.find((option) => isCloudManagedProviderKey(option.providerID));
  return replacement
    ? { providerID: replacement.providerID, modelID: replacement.modelID }
    : null;
}
