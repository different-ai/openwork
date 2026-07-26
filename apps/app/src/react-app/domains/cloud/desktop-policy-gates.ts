import {
  getDesktopPolicyDefinition,
  type DesktopPolicyKey,
} from "@openwork/types/den/desktop-policies";

import {
  checkDesktopAppRestriction,
  type DesktopAppRestrictionChecker,
} from "../../../app/cloud/desktop-app-restrictions";
import type { DenDesktopConfig } from "../../../app/lib/den";
import type { SettingsTab } from "../../../app/types";

export function getDesktopPolicyUserNotice(restriction: DesktopPolicyKey): string {
  return getDesktopPolicyDefinition(restriction).userNotice;
}

export function getDesktopRestrictionDisabledReason(input: {
  checkRestriction: DesktopAppRestrictionChecker;
  restriction: DesktopPolicyKey;
}): string | null {
  return input.checkRestriction({ restriction: input.restriction })
    ? getDesktopPolicyUserNotice(input.restriction)
    : null;
}

export function getDesktopConfigRestrictionDisabledReason(input: {
  config: DenDesktopConfig | null | undefined;
  restriction: DesktopPolicyKey;
}): string | null {
  return checkDesktopAppRestriction(input)
    ? getDesktopPolicyUserNotice(input.restriction)
    : null;
}

export function isControlSettingsTabAllowed(tab: SettingsTab): boolean {
  switch (tab) {
    case "ai":
    case "cloud-account":
    case "cloud-providers":
    case "connect":
    case "recovery":
      return true;
    default:
      return false;
  }
}

export function getControlSettingsRouteDisabledReason(input: {
  config: DenDesktopConfig | null | undefined;
  tab: SettingsTab;
}): string | null {
  const disabledReason = getDesktopConfigRestrictionDisabledReason({
    config: input.config,
    restriction: "allowControlSettings",
  });

  if (!disabledReason || isControlSettingsTabAllowed(input.tab)) return null;

  return disabledReason;
}
