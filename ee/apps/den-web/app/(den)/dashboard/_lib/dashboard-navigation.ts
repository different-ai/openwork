import {
  BarChart3,
  Box,
  CalendarClock,
  Globe,
  Laptop,
  LayoutDashboard,
  LibraryBig,
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
  getAutomationsRoute,
  getBillingRoute,
  getModelConnectionsRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getLibraryRoute,
  getManagedDashboardsRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getOrgSettingsRoute,
  getPluginsRoute,
  getScimRoute,
  getSsoRoute,
  getToolTesterRoute,
  getWebRoute,
} from "../../_lib/den-org";
import type { DenOrgMode } from "../../_lib/runtime-config";

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
};

export function buildDashboardNavSections({
  orgSlug,
  access,
  capabilities,
  runtimeConfigLoaded,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  const workflowsEnabled = capabilities.workflows;
  const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;
  const workItems: DashboardNavItem[] = [
    {
      href: orgSlug ? getLibraryRoute(orgSlug) : "#",
      label: "My Library",
      icon: LibraryBig,
    },
    ...(orgSlug
      ? [{ href: getModelConnectionsRoute(orgSlug), label: "My Model Connections", icon: Sparkles }]
      : []),
    ...(workflowsEnabled && orgSlug
      ? [{ href: getAutomationsRoute(orgSlug), label: "My Automations", icon: CalendarClock }]
      : []),
    ...(showWeb
      ? [{ href: orgSlug ? getWebRoute(orgSlug) : "#", label: "OpenWork Web", icon: Globe }]
      : []),
  ];

  const manageItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        { href: getPluginsRoute(orgSlug), label: "Plugins", icon: Box },
        { href: getMcpConnectionsRoute(orgSlug), label: "Connectors", icon: Plug },
        ...(capabilities.orgManagedDashboards
          ? [{ href: getManagedDashboardsRoute(orgSlug), label: "Dashboards", icon: LayoutDashboard }]
          : []),
        { href: getAiGatewayRoute(orgSlug), label: "AI Gateway", icon: Sparkles },
        { href: getDesktopPoliciesRoute(orgSlug), label: "Desktop policies", icon: Laptop },
      ]
    : [];
  const observabilityItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        { href: getAnalyticsRoute(orgSlug), label: "Analytics", icon: BarChart3 },
      ]
    : [];
  const settingsChildren: DashboardNavChild[] = orgSlug
    ? [
        ...(access.canViewSettings
          ? [
              { href: getOrgSettingsRoute(orgSlug), label: "General" },
              { href: getDiagnosticsRoute(orgSlug), label: "Diagnostics" },
              { href: getBillingRoute(orgSlug), label: "Billing" },
              { href: getApiKeysRoute(orgSlug), label: "API Keys" },
              { href: getSsoRoute(orgSlug), label: "SSO" },
              { href: getScimRoute(orgSlug), label: "SCIM" },
            ]
          : []),
        ...(access.isAdmin
          ? [{ href: getMarketplacesRoute(orgSlug), label: "Advanced" }]
          : []),
        ...(capabilities.mcpConnections && access.isAdmin
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
    ...(access.isAdmin && orgSlug
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

// Alias order is ranking priority in the command palette.
const PAGE_KEYWORDS: Record<string, string[]> = {
  Advanced: ["marketplace", "collections", "branding", "brand appearance"],
  "AI Gateway": ["llm", "provider", "gateway", "inference", "usage"],
  Analytics: ["usage", "stats", "consumption", "workflow runs", "history", "langfuse"],
  "API Keys": ["token", "secret"],
  Billing: ["plan", "invoice", "payment"],
  "Bring Your Own Keys (Legacy)": ["llm", "provider", "byok", "api key"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  "Desktop policies": ["policy", "mdm", "lock", "desktop"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "debug", "troubleshooting"],
  General: ["organization", "workspace"],
  Members: ["people", "users", "invite", "teams", "roles"],
  Models: ["llm", "provider", "byok", "api key"],
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
