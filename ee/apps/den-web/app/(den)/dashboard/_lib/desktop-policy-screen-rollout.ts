import { getOrgAccessFlags, type DenOrgContext } from "../../_lib/den-org";

/** Keep the desktop policy editor reachable for viewers without access to team settings. */
export function desktopPolicyScreenRemoved(context: DenOrgContext | null): boolean {
  if (!context) return false;
  const access = getOrgAccessFlags(context.currentMember.role, context.currentMember.isOwner, context.currentMember.permissions);
  return access.canViewSettings && access.canViewTeams && access.canViewDesktopPolicies;
}
