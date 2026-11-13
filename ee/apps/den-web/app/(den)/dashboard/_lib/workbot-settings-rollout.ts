import { getOrgAccessFlags, type DenOrgContext } from "../../_lib/den-org";

/**
 * Workbot's settings are on Members › Teams › Everyone (and each team) for this viewer, so Manage has no Workbot
 * entry. The page itself stays reachable for viewers who can't open team settings.
 */
export function workbotSettingsInTeams(context: DenOrgContext | null | undefined): boolean {
  if (!context) return false;
  const access = getOrgAccessFlags(context.currentMember.role, context.currentMember.isOwner, context.currentMember.permissions);
  return access.canViewSettings && access.canViewTeams && (access.canViewModelsSettings || access.canManageModelsSettings);
}
