import { getPermissionDefinition, type PermissionKey } from "@openwork/types/den/permissions";
import { type DenOrgAccessFlags, type DenOrgContext, getOrgAccessFlags } from "../../_lib/den-org";

/**
 * A part of the AI Gateway dashboard, named after the API reads it makes.
 * `any` is the Gateway as a whole: reachable with at least one Gateway permission.
 */
export type GatewayDashboardArea = "any" | "overview" | "providers" | "manage-providers" | "limits" | "manage-limits" | "people";

const GATEWAY_AREA_KEYS: Record<Exclude<GatewayDashboardArea, "any">, readonly PermissionKey[]> = {
  overview: ["gateway_providers.view", "gateway_usage.view"],
  providers: ["gateway_providers.view"],
  "manage-providers": ["gateway_providers.view", "gateway_providers.manage"],
  limits: ["gateway_limits.view"],
  "manage-limits": ["gateway_limits.view", "gateway_limits.manage"],
  people: ["gateway_providers.view", "gateway_usage.view", "gateway_limits.view"],
};

function holds(access: DenOrgAccessFlags, key: PermissionKey): boolean {
  switch (key) {
    case "gateway_providers.view": return access.canViewGatewayProviders;
    case "gateway_providers.manage": return access.canManageGatewayProviders;
    case "gateway_usage.view": return access.canViewGatewayUsage;
    case "gateway_limits.view": return access.canViewGatewayLimits;
    case "gateway_limits.manage": return access.canManageGatewayLimits;
    default: return false;
  }
}

export function canOpenGatewayArea(access: DenOrgAccessFlags, area: GatewayDashboardArea): boolean {
  if (area === "any") {
    return access.canViewGatewayProviders || access.canViewGatewayUsage || access.canViewGatewayLimits;
  }
  return GATEWAY_AREA_KEYS[area].every((key) => holds(access, key));
}

/** Plain reason shown where a Gateway area is locked (DESIGN.md P4). */
export function gatewayAreaLockedMessage(area: GatewayDashboardArea): string {
  const labels = area === "any" ? [] : GATEWAY_AREA_KEYS[area].map((key) => `“${getPermissionDefinition(key).label}”`);
  const needs = labels.length === 0
    ? "an AI Gateway permission"
    : labels.length === 1 ? `the ${labels[0]} permission` : `the ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]} permissions`;
  return `This needs ${needs}. Ask an organization owner or admin for access.`;
}

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
}, area: GatewayDashboardArea = "any"): "checking" | "denied" | "unavailable" | "enabled" {
  if (orgBusy || mutationBusy === "switch-organization") return "checking";
  if (orgError) return "denied";
  if (!orgId || !orgContext || orgId !== orgContext.organization.id) return "checking";
  const access = getOrgAccessFlags(
    orgContext.currentMember.role,
    orgContext.currentMember.isOwner,
    orgContext.currentMember.permissions,
  );
  if (!canOpenGatewayArea(access, area)) return "denied";
  return orgContext.deploymentCapabilities.version === 1 && orgContext.deploymentCapabilities.aiGateway === true
    ? "enabled" : "unavailable";
}
