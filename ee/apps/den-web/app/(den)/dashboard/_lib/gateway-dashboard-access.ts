import { type DenOrgContext, getOrgAccessFlags } from "../../_lib/den-org";

/** Never use retained capabilities while the active workspace is unresolved. */
export function getGatewayDashboardAccess({
  orgId,
  orgContext,
  orgBusy,
  orgError,
  mutationBusy,
}: {
  orgId: string | null;
  orgContext: DenOrgContext | null;
  orgBusy: boolean;
  orgError: string | null;
  mutationBusy: string | null;
}): "checking" | "denied" | "unavailable" | "enabled" {
  if (orgBusy || mutationBusy === "switch-organization") return "checking";
  if (orgError) return "denied";
  if (!orgId || !orgContext || orgId !== orgContext.organization.id) return "checking";
  const access = getOrgAccessFlags(
    orgContext.currentMember.role,
    orgContext.currentMember.isOwner,
    orgContext.roles,
  );
  if (!access.isAdmin || orgContext.capabilities.gatewayDashboard !== true) return "denied";
  return orgContext.deploymentCapabilities.version === 1 && orgContext.deploymentCapabilities.aiGateway === true
    ? "enabled" : "unavailable";
}
