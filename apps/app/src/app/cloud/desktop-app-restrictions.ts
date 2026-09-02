import {
  desktopPolicyUserNotices,
  type DesktopPolicyKey,
} from "@openwork/types/den/desktop-policies";
import type { DenDesktopConfig } from "../lib/den";
import type { ModelRef, SettingsTab } from "../types";

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

/** Catalog copy explaining why the organization blocked a capability. */
export function desktopRestrictionNotice(restriction: DesktopAppRestrictionKey) {
  return desktopPolicyUserNotices[restriction];
}

/**
 * Settings tabs that stay reachable when `allowControlSettings` is blocked.
 * Members can still see their Cloud account, switch organizations, and use
 * Cloud features that are not desktop settings; every other tab is hidden and
 * redirected.
 */
const SETTINGS_TABS_WITHOUT_CONTROL = new Set<SettingsTab>(["cloud-account"]);

export const SETTINGS_TAB_WITHOUT_CONTROL: SettingsTab = "cloud-account";

export function isSettingsTabAllowed(input: {
  tab: SettingsTab;
  checkRestriction: DesktopAppRestrictionChecker;
}) {
  if (!input.checkRestriction({ restriction: "allowControlSettings" })) return true;
  return SETTINGS_TABS_WITHOUT_CONTROL.has(input.tab);
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
