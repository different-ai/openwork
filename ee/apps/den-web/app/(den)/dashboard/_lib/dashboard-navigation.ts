import {
  BarChart3,
  Box,
  CalendarClock,
  Globe,
  Laptop,
  LibraryBig,
  LockKeyhole,
  MessageCircle,
  ScrollText,
  Server,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  type DenOrgAccessFlags,
  type DenOrgCapabilities,
  getAiGatewayRoute,
  getAnalyticsRoute,
  getApiKeysRoute,
  getAuditLogsRoute,
  getAutomationsRoute,
  getBillingRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getDeploymentsRoute,
  getLibraryRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getOrgSettingsRoute,
  getPermissionsRoute,
  getPluginsRoute,
  getScimRoute,
  getSsoRoute,
  getToolTesterRoute,
  getWebRoute,
} from "../../_lib/den-org";
import type { DenOrgMode } from "../../_lib/runtime-config";
import { canOpenAdminRoute } from "./admin-route-access";

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
  /** Quiet dot beside the label when something here is waiting on the viewer. */
  attention?: string;
  testId?: string;
  /** Extra pathname prefixes that select this entry. */
  matchHrefs?: string[];
  /** Grouped entries link to their own href and expand on parent or child pages. */
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
  /** How many Library items wait on the viewer's sign-in. */
  libraryNeedsSignIn?: number;
  /** The organization has the `permissions` feature (orgFeatureEnabled). */
  permissionsEnabled?: boolean;
  /** The managedDeployments feature is on for this organization. */
  managedDeployments?: boolean;
};

export function buildDashboardNavSections({
  orgSlug,
  access,
  capabilities,
  runtimeConfigLoaded,
  libraryNeedsSignIn = 0,
  permissionsEnabled = false,
  managedDeployments = false,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  const workflowsEnabled = capabilities.workflows;
  const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;
  const workItems: DashboardNavItem[] = [
    ...(capabilities.workbot
      ? [{ href: "/workbot", label: "Workbot", icon: MessageCircle, testId: "dashboard-nav-workbot" }]
      : []),
    {
      href: orgSlug ? getLibraryRoute(orgSlug) : "#",
      label: "My Library",
      icon: LibraryBig,
      ...(libraryNeedsSignIn > 0
        ? { attention: `${libraryNeedsSignIn} ${libraryNeedsSignIn === 1 ? "needs" : "need"} your sign-in` }
        : {}),
    },
    ...(workflowsEnabled && orgSlug
      ? [{ href: getAutomationsRoute(orgSlug), label: "My Automations", icon: CalendarClock }]
      : []),
    ...(showWeb
      ? [{ href: orgSlug ? getWebRoute(orgSlug) : "#", label: "OpenWork Web", icon: Globe }]
      : []),
  ];

  // Admin-area entries appear only where the member holds the page's permission.
  const canOpen = (href: string) => canOpenAdminRoute(href, access);
  const manageItems: DashboardNavItem[] = orgSlug
    ? [
        { href: getPluginsRoute(orgSlug), label: "Plugins", icon: Box },
        { href: getMcpConnectionsRoute(orgSlug), label: "Connectors", icon: Plug, badge: "MCPs" },
        { href: getAiGatewayRoute(orgSlug), label: "AI Gateway", icon: Sparkles },
        { href: getDesktopPoliciesRoute(orgSlug), label: "Desktop policies", icon: Laptop },
        ...(managedDeployments ? [{ href: getDeploymentsRoute(orgSlug), label: "Deployments", icon: Server }] : []),
      ].filter((item) => canOpen(item.href))
    : [];
  const observabilityItems: DashboardNavItem[] = orgSlug
    ? [
        ...(access.canViewUsageAnalytics ? [{ href: getAnalyticsRoute(orgSlug), label: "Analytics", icon: BarChart3 }] : []),
        ...(capabilities.auditLogs
          ? [{
              href: getAuditLogsRoute(orgSlug),
              label: "Audit logs",
              icon: access.canViewAuditLogs ? ScrollText : LockKeyhole,
              ...(access.canViewAuditLogs ? {} : { badge: "Locked" }),
            }]
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
        ...permissionsNavChildren(orgSlug, access, permissionsEnabled),
        ...(access.canViewSso ? [{ href: getSsoRoute(orgSlug), label: "SSO" }] : []),
        ...(access.canViewScim ? [{ href: getScimRoute(orgSlug), label: "SCIM" }] : []),
        ...(canOpen(getMarketplacesRoute(orgSlug))
          ? [{ href: getMarketplacesRoute(orgSlug), label: "Advanced" }]
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
      ? [{ href: getMembersRoute(orgSlug), label: "Members", icon: Users }]
      : []),
    ...(settingsGroup ? [settingsGroup] : []),
  ];

  return [
    { label: "Work", items: workItems },
    ...(manageItems.length > 0 ? [{ label: "Manage", items: manageItems }] : []),
    ...(observabilityItems.length > 0 ? [{ label: "Observability", items: observabilityItems }] : []),
    ...(teamItems.length > 0 ? [{ label: "Team", items: teamItems }] : []),
  ];
}

/**
 * Permissions appears for members who hold `permissions.view` while the feature
 * is on. While it is off, people who could manage it keep a locked entry that
 * says why (DESIGN.md P4); everyone else does not see it.
 */
function permissionsNavChildren(orgSlug: string, access: DenOrgAccessFlags, enabled: boolean): DashboardNavChild[] {
  const href = getPermissionsRoute(orgSlug);
  if (enabled) return access.canViewPermissions ? [{ href, label: "Permissions" }] : [];
  return access.canManagePermissions ? [{ href, label: "Permissions", badge: "Enterprise" }] : [];
}

// Alias order is ranking priority in the command palette.
const PAGE_KEYWORDS: Record<string, string[]> = {
  Advanced: ["marketplace", "collections", "branding", "brand appearance"],
  "AI Gateway": ["llm", "provider", "gateway", "inference", "usage"],
  Analytics: ["usage", "stats", "consumption", "workflow runs", "history", "langfuse"],
  "Audit logs": ["audit", "history", "operations", "changes", "security"],
  "API Keys": ["token", "secret"],
  Billing: ["plan", "invoice", "payment"],
  "Bring Your Own Keys (Legacy)": ["llm", "provider", "byok", "api key"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  "Desktop policies": ["policy", "mdm", "lock", "desktop"],
  Deployments: ["aws", "self-hosted", "byoc", "install", "health", "status"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "debug", "troubleshooting"],
  General: ["organization", "workspace"],
  Members: ["people", "users", "invite", "teams", "roles"],
  Models: ["llm", "provider", "byok", "api key"],
  Permissions: ["access", "roles", "teams", "admin", "rbac"],
  "My Automations": ["schedule", "recurring", "tasks"],
  "My Library": ["skills", "plugins", "connections"],
  "OpenWork Models": ["llm", "provider", "managed", "inference"],
  "OpenWork Web": ["cloud", "sessions"],
  Plugins: ["skills", "commands", "plugin directory"],
  SCIM: ["provisioning", "directory", "users"],
  Settings: ["organization", "workspace"],
  SSO: ["single sign on", "saml", "oidc"],
  "Tool Tester": ["tools", "test", "mcp"],
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
