import type { DesktopPolicyKey } from "@openwork/types/den/desktop-policies";
import type { DenDesktopConfig } from "../lib/den";
import type { ModelRef } from "../types";

export type DesktopAppRestrictionKey = DesktopPolicyKey;

export type DesktopAppRestrictionChecker = (input: {
  restriction: DesktopAppRestrictionKey;
}) => boolean;

export const DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID = "opencode";

export function checkDesktopAppRestriction(input: {
  config: DenDesktopConfig | null | undefined;
  restriction: DesktopAppRestrictionKey;
}) {
  return input.config?.[input.restriction] === false;
}

export function isDesktopProviderBlocked(input: {
  providerId: string;
  checkRestriction: DesktopAppRestrictionChecker;
}) {
  const providerId = input.providerId.trim().toLowerCase();
  if (!providerId) return false;

  if (providerId === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
    return input.checkRestriction({ restriction: "allowZenModel" });
  }

  return false;
}

export function isDesktopModelBlocked(input: {
  model: ModelRef;
  checkRestriction: DesktopAppRestrictionChecker;
}) {
  return isDesktopProviderBlocked({
    providerId: input.model.providerID,
    checkRestriction: input.checkRestriction,
  });
}
