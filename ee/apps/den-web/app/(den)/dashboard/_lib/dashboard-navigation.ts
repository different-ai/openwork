import {
  BarChart3,
  Box,
  CalendarClock,
  Gauge,
  Radar,
  Globe,
  House,
  Laptop,
  LibraryBig,
  MessageCircle,
  MonitorSmartphone,
  ScrollText,
  Server,
  Plug,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import {
  type DenOrgAccessFlags,
  type DenOrgCapabilities,
  getAiGatewayRoute,
  getAnalyticsRoute,
  getApiKeysRoute,
  getAuditLogsRoute,
  getAuthSecurityRoute,
  getAutomationsRoute,
  getBillingRoute,
  getCapabilitiesRoute,
  getConfigRoute,
  getComputersRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getDeploymentsRoute,
  getLibraryMyAgentRoute,
  getLibraryRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRolesRoute,
  getMembersRoute,
  getMembersTeamsRoute,
  getMyComputersRoute,
  getMyUsageRoute,
  getOrgDashboardRoute,
  getOrgSettingsRoute,
  getPermissionsRoute,
  getPluginsRoute,
  getToolTesterRoute,
  getWebRoute,
  getWorkbotSettingsRoute,
} from "../../_lib/den-org";
import type { DenOrgMode } from "../../_lib/runtime-config";
import { agentsAdminRoute, canOpenAdminRoute } from "./admin-route-access";
import { type WorkbotEntry, workbotEntryHref, workbotNavMarker } from "./workbot-entry";

export type DashboardNavChild = {
  href: string;
  label: string;
  badge?: string;
};

export type DashboardNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  attention?: string;
  exact?: boolean;
  locked?: string;
  testId?: string;
  matchHrefs?: string[];
  children?: DashboardNavChild[];
};

export type DashboardNavSection = {
  label: string;
  items: DashboardNavItem[];
};

export type DashboardSearchItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  section: string;
  keywords: string[];
};

export type BuildDashboardNavSectionsInput = {
  orgSlug: string | null;
  access: DenOrgAccessFlags;
  capabilities: DenOrgCapabilities;
  orgMode: DenOrgMode;
  runtimeConfigLoaded: boolean;
  libraryNeedsSignIn?: number;
  managedDeployments?: boolean;
  personalAgents?: boolean;
  capabilitiesView?: boolean;
  desktopPolicyScreenRemoved?: boolean;
  workbotSettingsInTeams?: boolean;
  canManageDeploymentServices?: boolean;
  workbotEntry?: WorkbotEntry;
  organizationId?: string | null;
};

export function buildDashboardNavSections({
  orgSlug,
  access,
  capabilities,
  runtimeConfigLoaded,
  libraryNeedsSignIn = 0,
  managedDeployments = false,
  personalAgents = false,
  capabilitiesView = false,
  desktopPolicyScreenRemoved = false,
  workbotSettingsInTeams = false,
  canManageDeploymentServices = false,
  workbotEntry = { kind: "open" },
  organizationId = null,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  const workbotOff = workbotEntry.kind === "off";
  const workItems: DashboardNavItem[] = [
    ...(orgSlug
      ? [{
          href: getOrgDashboardRoute(orgSlug),
          label: "Home",
          icon: House,
          testId: "dashboard-nav-home",
          ...(!access.isAdmin && libraryNeedsSignIn > 0
            ? { attention: `${libraryNeedsSignIn} ${libraryNeedsSignIn === 1 ? "needs" : "need"} your sign-in` }
            : {}),
        }]
      : []),
    ...(capabilities.workbot && !workbotOff
      ? [{ href: workbotEntryHref(organizationId), label: "Workbot", icon: MessageCircle, testId: "dashboard-nav-workbot", ...workbotNavMarker(workbotEntry) }]
      : []),
  ];

  const canOpen = (href: string) => canOpenAdminRoute(href, access, canManageDeploymentServices);
  const manageItems: DashboardNavItem[] = orgSlug
    ? [
        { href: getPluginsRoute(orgSlug), label: "Plugins", icon: Box },
        { href: getMcpConnectionsRoute(orgSlug), label: "Connectors", icon: Plug, badge: "MCPs" },
        { href: getAiGatewayRoute(orgSlug), label: "AI Gateway", icon: Sparkles },
        ...(!desktopPolicyScreenRemoved ? [{ href: getDesktopPoliciesRoute(orgSlug), label: "Desktop policies", icon: Laptop }] : []),
        { href: getComputersRoute(orgSlug), label: "Computers", icon: Laptop, testId: "dashboard-nav-computers" },
        ...(!workbotSettingsInTeams ? [{ href: getWorkbotSettingsRoute(orgSlug), label: "Workbot", icon: MessageCircle, testId: "dashboard-nav-workbot-settings" }] : []),
        ...(managedDeployments ? [{ href: getDeploymentsRoute(orgSlug), label: "Deployments", icon: Server }] : []),
        ...(personalAgents ? [{ href: agentsAdminRoute, label: "Agents", icon: Radar }] : []),
      ].filter((item) => canOpen(item.href))
    : [];
  const observabilityItems: DashboardNavItem[] = orgSlug
    ? [
        ...(access.canViewUsageAnalytics ? [{ href: getAnalyticsRoute(orgSlug), label: "Analytics", icon: BarChart3 }] : []),
        ...(capabilities.auditLogs && access.canViewAuditLogs
          ? [{ href: getAuditLogsRoute(orgSlug), label: "Audit logs", icon: ScrollText }]
          : []),
      ]
    : [];
  const settingsChildren: DashboardNavChild[] = orgSlug
    ? [
        ...[
          { href: getOrgSettingsRoute(orgSlug), label: "General" },
          { href: getDiagnosticsRoute(orgSlug), label: "Diagnostics" },
          { href: getBillingRoute(orgSlug), label: "Billing" },
          { href: getApiKeysRoute(orgSlug), label: "API Keys" },
        ].filter((item) => canOpen(item.href)),
        ...permissionsNavChildren(orgSlug, access, canOpen(getMembersRoute(orgSlug))),
        ...authSecurityNavChildren(orgSlug, access),
        ...(canOpen(getMarketplacesRoute(orgSlug))
          ? [{ href: getMarketplacesRoute(orgSlug), label: "Advanced" }]
          : []),
        ...(capabilitiesView && canOpen(getCapabilitiesRoute(orgSlug))
          ? [{ href: getCapabilitiesRoute(orgSlug), label: "Capabilities" }]
          : []),
        ...(canOpen(getConfigRoute(orgSlug))
          ? [{ href: getConfigRoute(orgSlug), label: "Config" }]
          : []),
        ...(capabilities.mcpConnections && canOpen(getToolTesterRoute(orgSlug))
          ? [{ href: getToolTesterRoute(orgSlug), label: "Tool Tester" }]
          : []),
      ]
    : [];
  const settingsGroup: DashboardNavItem | null = settingsChildren.length > 0
    ? {
        href: settingsChildren[0].href,
        label: "Settings",
        icon: SlidersHorizontal,
        children: settingsChildren,
      }
    : null;
  const teamItems: DashboardNavItem[] = [
    ...(orgSlug && canOpen(getMembersRoute(orgSlug))
      ? [
          { href: getMembersRoute(orgSlug), label: "Members", icon: User, exact: true },
          { href: getMembersTeamsRoute(orgSlug), label: "Teams", icon: Users },
          { href: getMembersRolesRoute(orgSlug), label: "Roles", icon: ShieldCheck },
        ]
      : []),
    ...(settingsGroup ? [settingsGroup] : []),
  ];

  return [
    { label: "Work", items: workItems },
    ...(manageItems.length > 0 ? [{ label: "Manage", items: manageItems }] : []),
    ...(observabilityItems.length > 0 ? [{ label: "Observability", items: observabilityItems }] : []),
    ...(teamItems.length > 0 ? [{ label: "Organization", items: teamItems }] : []),
  ];
}

export function buildPersonalPagesSection({
  orgSlug,
  capabilities,
  runtimeConfigLoaded,
  workbotEntry = { kind: "open" },
  myBot = false,
}: Pick<BuildDashboardNavSectionsInput, "orgSlug" | "capabilities" | "runtimeConfigLoaded" | "workbotEntry"> & { myBot?: boolean }): DashboardNavSection {
  if (!orgSlug) return { label: PERSONAL_PAGES_LABEL, items: [] };
  return {
    label: PERSONAL_PAGES_LABEL,
    items: [
      ...(myBot && workbotEntry.kind !== "off"
        ? [{ href: getLibraryMyAgentRoute(orgSlug), label: "My bot", icon: Radar }]
        : []),
      { href: getLibraryRoute(orgSlug), label: "My Library", icon: LibraryBig },
      ...(capabilities.workflows ? [{ href: getAutomationsRoute(orgSlug), label: "My Automations", icon: CalendarClock }] : []),
      { href: getMyComputersRoute(orgSlug), label: "My Computers", icon: MonitorSmartphone },
      { href: getMyUsageRoute(orgSlug), label: "My Usage", icon: Gauge },
      ...(runtimeConfigLoaded && capabilities.openworkWeb ? [{ href: getWebRoute(orgSlug), label: "OpenWork Web", icon: Globe }] : []),
    ],
  };
}

const PERSONAL_PAGES_LABEL = "Yours";

function permissionsNavChildren(orgSlug: string, access: DenOrgAccessFlags, membersOpen: boolean): DashboardNavChild[] {
  return access.canViewPermissions && !membersOpen ? [{ href: getPermissionsRoute(orgSlug), label: "Roles" }] : [];
}

function authSecurityNavChildren(orgSlug: string, access: DenOrgAccessFlags): DashboardNavChild[] {
  return access.canViewSso || access.canViewScim ? [{ href: getAuthSecurityRoute(orgSlug), label: "Auth & Security" }] : [];
}

const PAGE_KEYWORDS: Record<string, string[]> = {
  Advanced: ["marketplace", "collections", "branding", "brand appearance"],
  "AI Gateway": ["llm", "provider", "gateway", "inference", "usage"],
  Analytics: ["usage", "stats", "workflow runs", "history"],
  "Audit logs": ["audit", "history", "operations", "changes", "security"],
  "API Keys": ["token", "secret"],
  "Auth & Security": ["sso", "single sign on", "saml", "oidc", "scim", "provisioning", "directory", "okta", "entra", "identity provider"],
  Billing: ["plan", "invoice", "payment"],
  Capabilities: ["installed", "infrastructure", "member access", "workbot", "slack assistant", "automations", "ai gateway", "cloud computers"],
  Config: ["export", "import", "backup", "json", "copy settings", "change requests", "revert"],
  "Bring Your Own Keys (Legacy)": ["llm", "provider", "byok", "api key"],
  Computers: ["devices", "team computers", "desktop", "virtual computers", "inventory", "owners", "remote access", "other devices"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  "Desktop policies": ["policy", "mdm", "lock", "desktop"],
  Deployments: ["aws", "self-hosted", "byoc", "install", "health", "status"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "status", "services", "readiness", "debug", "troubleshooting", "desktop startup"],
  General: ["organization", "workspace"],
  Home: ["dashboard", "start", "download", "api keys", "spend"],
  Members: ["people", "users", "invite", "teams", "roles", "agent permissions", "commands", "websites", "allow list", "block list", "desktop", "prompt suggestions"],
  Models: ["llm", "provider", "byok", "api key"],
  Permissions: ["access", "roles", "teams", "admin", "rbac"],
  "My Automations": ["schedule", "recurring", "tasks"],
  "My Computers": ["devices", "my devices", "laptop", "desktop", "virtual computers", "workbot computer", "remote access", "other devices", "tasks"],
  "My bot": ["agent", "my agent", "morning brief", "meeting prep", "proactive", "notifications"],
  "My Library": ["skills", "plugins", "connections"],
  "My Usage": ["usage", "spend", "cost", "limits", "budget", "tokens", "prices", "models"],
  "OpenWork Models": ["llm", "provider", "managed", "inference"],
  "OpenWork Web": ["cloud", "sessions"],
  Plugins: ["skills", "commands", "plugin directory"],
  Settings: ["organization", "workspace"],
  "Tool Tester": ["tools", "test", "mcp"],
  Workbot: ["model", "default model", "assistant", "slack", "automations"],
};

function keywordsFor(...labels: string[]): string[] {
  return [...new Set(labels.flatMap((label) => PAGE_KEYWORDS[label] ?? []))];
}

export function flattenNavigationForSearch(sections: DashboardNavSection[]): DashboardSearchItem[] {
  return sections.flatMap((section) => section.items.flatMap((item) => {
    if (item.children) {
      return item.children.map((child) => ({
        id: `page:${section.label}:${item.label}:${child.label}`,
        label: `${item.label} › ${child.label}`,
        href: child.href,
        icon: item.icon,
        section: section.label,
        keywords: keywordsFor(item.label, child.label),
      }));
    }

    return [{
      id: `page:${section.label}:${item.label}`,
      label: item.label,
      href: item.href,
      icon: item.icon,
      section: section.label,
      keywords: keywordsFor(item.label),
    }];
  }));
}
