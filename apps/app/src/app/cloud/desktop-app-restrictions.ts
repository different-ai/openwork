import {
  desktopPolicyKeyEnforced,
  desktopPolicyUserNotices,
  isLocalModelProviderId,
  localModelsAllowed,
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
  if (input.restriction === "allowZenModel") {
    return true;
  }
  if (input.restriction === "allowLocalModels") {
    return Boolean(input.config) && !localModelsAllowed(input.config);
  }
  return desktopPolicyKeyEnforced(input.restriction) && input.config?.[input.restriction] === false;
}

const RETIRED_OPENCODE_ZEN_TERMS = "opencode zen big pickle free";

export function showsRetiredOpencodeZen(input: { providerIds: readonly string[]; query: string }) {
  if (input.providerIds.some((id) => id.trim().toLowerCase() === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID)) return false;
  const query = input.query.trim().toLowerCase();
  return !query || RETIRED_OPENCODE_ZEN_TERMS.includes(query);
}

export function desktopRestrictionNotice(restriction: DesktopAppRestrictionKey) {
  return desktopPolicyUserNotices[restriction];
}

const SETTINGS_TABS_WITHOUT_CONTROL = new Set<SettingsTab>(["cloud-account", "usage", "devices"]);

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
  if (isLocalModelProviderId(providerId)) {
    return input.checkRestriction({ restriction: "allowLocalModels" });
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
