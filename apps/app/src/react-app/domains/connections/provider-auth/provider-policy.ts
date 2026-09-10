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
    // A catalog is an availability snapshot, not permission to replace a
    // remembered organization selection. Let unavailable-model recovery ask
    // the user when that model is truly gone.
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
  /** Connected providers of the selected workspace engine. */
  runtimeOptions: readonly ModelEntitlementOption[];
  /**
   * A workspace engine is connected but its catalog has not answered yet
   * (for example while it reloads with a freshly configured provider).
   */
  runtimeCatalogPending: boolean;
  /** Organization-assigned models: the stand-in before a workspace engine exists. */
  assignedOptions: readonly ModelEntitlementOption[];
};

/**
 * Which organization model, if any, should replace the stored default. The
 * workspace engine's catalog is the source of truth; organization-assigned
 * models stand in only when that catalog has nothing to offer. A catalog that
 * is still loading is not an empty catalog: no verdict is reached until it
 * answers, so a configured non-cloud default is never replaced by an
 * organization model merely because the engine has not listed it yet.
 */
export function resolveOrgDefaultModelReplacement(
  input: OrgDefaultModelReplacementInput,
): ModelRef | null {
  if (input.runtimeCatalogPending) return null;
  return resolveEntitledOrgDefaultModel(
    input.runtimeOptions.length > 0 ? input.runtimeOptions : input.assignedOptions,
    input,
  );
}
