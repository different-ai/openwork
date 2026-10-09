import { getPermissionDefinition, type PermissionKey } from "@openwork/types/den/permissions";
import {
  type DenOrgAccessFlags,
  getAgentPermissionsRoute,
  getAiGatewayRoute,
  getApiKeysRoute,
  getBillingRoute,
  getCustomLlmProvidersRoute,
  getAnalyticsRoute,
  getDeploymentsRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getImportPluginRoute,
  getIntegrationsRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getOrgDashboardRoute,
  getPermissionsRoute,
  getPluginsRoute,
  getToolTesterRoute,
} from "../../_lib/den-org";
import { canOpenGatewayArea } from "./gateway-dashboard-access";

/**
 * What each page in the admin area needs, matching the Den API route it reads
 * (docs/permissions/route-inventory.md). Pages not listed here only need the
 * admin area itself (`canViewSettings`) and gate their own controls.
 */
type AdminRouteRule = {
  /** Route prefix the rule covers; the longest match wins. */
  prefix: string;
  allowed: (access: DenOrgAccessFlags) => boolean;
  /** Permissions named in the locked state; holding any one is enough unless `allowed` says otherwise. */
  needs: readonly PermissionKey[];
};

const MEMBERS_AREA_KEYS: readonly PermissionKey[] = [
  "invitations.manage", "members.update", "members.delete", "teams.view", "teams.manage", "teams.manage_admin",
];

const ADMIN_ROUTE_RULES: readonly AdminRouteRule[] = [
  {
    prefix: getAiGatewayRoute(),
    allowed: (access) => canOpenGatewayArea(access, "any") || access.canViewModelsSettings,
    needs: ["gateway_providers.view", "gateway_usage.view", "gateway_limits.view", "inference.view"],
  },
  { prefix: `${getOrgDashboardRoute()}/inference`, allowed: (access) => access.canViewModelsSettings, needs: ["inference.view"] },
  { prefix: getApiKeysRoute(), allowed: (access) => access.canViewApiKeys, needs: ["api_keys.view"] },
  { prefix: getBillingRoute(), allowed: (access) => access.canViewBilling, needs: ["billing.view"] },
  { prefix: getCustomLlmProvidersRoute(), allowed: (access) => access.canViewAllLlmProviders, needs: ["llm_providers.view"] },
  { prefix: getDesktopPoliciesRoute(), allowed: (access) => access.canViewDesktopPolicies, needs: ["desktop_policies.view"] },
  { prefix: getAgentPermissionsRoute(), allowed: (access) => access.canViewDesktopPolicies, needs: ["desktop_policies.view"] },
  { prefix: getDeploymentsRoute(), allowed: (access) => access.canViewDeployments, needs: ["deployments.view"] },
  { prefix: getAnalyticsRoute(), allowed: (access) => access.canViewUsageAnalytics, needs: ["usage_analytics.view"] },
  { prefix: getDiagnosticsRoute(), allowed: (access) => access.canViewEgressDiagnostics, needs: ["egress_diagnostics.view"] },
  { prefix: getIntegrationsRoute(), allowed: (access) => access.canManageSyncSources, needs: ["connectors.manage"] },
  {
    prefix: getMembersRoute(),
    allowed: (access) => access.canInviteMembers || access.canManageMembers || access.canRemoveMembers
      || access.canViewTeams || access.canManageTeams || access.canManageAdminTeams,
    needs: MEMBERS_AREA_KEYS,
  },
  { prefix: `${getMembersRoute()}/teams`, allowed: (access) => access.canViewTeams, needs: ["teams.view"] },
  {
    prefix: `${getOrgDashboardRoute()}/manage-members`,
    allowed: (access) => access.canInviteMembers || access.canManageMembers || access.canRemoveMembers
      || access.canViewTeams || access.canManageTeams || access.canManageAdminTeams,
    needs: MEMBERS_AREA_KEYS,
  },
  // Feature-off and read-only states are shown by the Permissions screens themselves.
  { prefix: getPermissionsRoute(), allowed: (access) => access.canViewPermissions, needs: ["permissions.view"] },
  { prefix: `${getPermissionsRoute()}/new`, allowed: (access) => access.canManagePermissions, needs: ["permissions.manage"] },
  { prefix: getMcpConnectionsRoute(), allowed: (access) => access.canViewAllConnections, needs: ["connections.view"] },
  { prefix: `${getMcpConnectionsRoute()}/new`, allowed: (access) => access.canManageConnections, needs: ["connections.manage"] },
  {
    prefix: getPluginsRoute(),
    allowed: (access) => access.canManageAllShared || access.canManageSyncSources || access.canImportPlugins,
    needs: ["sharing.manage_all", "connectors.manage", "plugins.import"],
  },
  { prefix: getImportPluginRoute(), allowed: (access) => access.canImportPlugins, needs: ["plugins.import"] },
  { prefix: getToolTesterRoute(), allowed: (access) => access.canManageConnections, needs: ["connections.manage"] },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function ruleFor(pathname: string): AdminRouteRule | null {
  let match: AdminRouteRule | null = null;
  for (const rule of ADMIN_ROUTE_RULES) {
    if (matchesPrefix(pathname, rule.prefix) && (!match || rule.prefix.length > match.prefix.length)) match = rule;
  }
  return match;
}

/** Whether the member can open this admin-area page. */
export function canOpenAdminRoute(pathname: string, access: DenOrgAccessFlags): boolean {
  if (!access.canViewSettings) return false;
  const rule = ruleFor(pathname);
  return rule ? rule.allowed(access) : true;
}

/** Plain reason for a locked admin page (DESIGN.md P4). */
export function adminRouteLockedMessage(pathname: string): string {
  const labels = (ruleFor(pathname)?.needs ?? []).map((key) => `“${getPermissionDefinition(key).label}”`);
  const needs = labels.length === 0
    ? "an organization permission"
    : labels.length === 1 ? `the ${labels[0]} permission` : `one of these permissions: ${labels.join(", ")}`;
  return `This page needs ${needs}. Ask an organization owner or admin for access.`;
}
