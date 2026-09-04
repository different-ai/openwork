import {
  BarChart3,
  Box,
  CalendarClock,
  Globe,
  Home,
  LayoutDashboard,
  LibraryBig,
  Plug,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  type DenOrgAccessFlags,
  type DenOrgCapabilities,
  getAnalyticsRoute,
  getApiKeysRoute,
  getAutomationsRoute,
  getBillingRoute,
  getBrandAppearanceRoute,
  getCustomLlmProvidersRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getInferenceRoute,
  getLibraryRoute,
  getManagedDashboardsRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getOrgDashboardRoute,
  getOrgSettingsRoute,
  getPluginsRoute,
  getScimRoute,
  getSsoRoute,
  getToolTesterRoute,
  getWebRoute,
  getWorkflowRunsRoute,
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
  /** Grouped entries link to the first child and expand on child pages. */
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
  orgMode,
  runtimeConfigLoaded,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  const workflowsEnabled = capabilities.workflows;
  const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;
  const workItems: DashboardNavItem[] = [
    {
      href: orgSlug ? getOrgDashboardRoute(orgSlug) : "#",
      label: "Dashboard",
      icon: Home,
    },
    {
      href: orgSlug ? getLibraryRoute(orgSlug) : "#",
      label: "My Library",
      icon: LibraryBig,
    },
    ...(workflowsEnabled && orgSlug
      ? [{ href: getAutomationsRoute(orgSlug), label: "My Automations", icon: CalendarClock }]
      : []),
    ...(showWeb
      ? [{ href: orgSlug ? getWebRoute(orgSlug) : "#", label: "OpenWork Web", icon: Globe }]
      : []),
  ];

  // Hosted deployments expose OpenWork Models; self-hosted deployments only
  // expose their own providers. Keep hidden until runtime config is known.
  const showOpenWorkModels = runtimeConfigLoaded && orgMode === "multi_org";
  const modelsGroup: DashboardNavItem | null = access.isAdmin && orgSlug
    ? {
        href: showOpenWorkModels
          ? getInferenceRoute(orgSlug)
          : getCustomLlmProvidersRoute(orgSlug),
        label: "Models",
        icon: Sparkles,
        badge: "Providers",
        children: [
          ...(showOpenWorkModels
            ? [{ href: getInferenceRoute(orgSlug), label: "OpenWork Models" }]
            : []),
          { href: getCustomLlmProvidersRoute(orgSlug), label: "Bring your Own Keys" },
        ],
      }
    : null;
  const manageItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        { href: getPluginsRoute(orgSlug), label: "Plugin Directory", icon: Box },
        {
          href: getMcpConnectionsRoute(orgSlug),
          label: "Connectors",
          icon: Plug,
          badge: "MCPs",
        },
        ...(capabilities.mcpConnections && access.isAdmin
          ? [{ href: getToolTesterRoute(orgSlug), label: "Tool Tester", icon: Wrench }]
          : []),
        ...(capabilities.orgManagedDashboards
          ? [{ href: getManagedDashboardsRoute(orgSlug), label: "Dashboards", icon: LayoutDashboard }]
          : []),
        ...(modelsGroup ? [modelsGroup] : []),
        {
          href: getMarketplacesRoute(orgSlug),
          label: "Advanced",
          icon: Settings2,
          matchHrefs: [
            getDesktopPoliciesRoute(orgSlug),
            getBrandAppearanceRoute(orgSlug),
          ],
        },
      ]
    : [];
  const observabilityItems: DashboardNavItem[] = access.isAdmin && orgSlug
    ? [
        ...(workflowsEnabled
          ? [{
              href: getWorkflowRunsRoute(orgSlug),
              label: "Workflow Runs",
              icon: ScrollText,
              testId: "nav-workflow-runs",
            }]
          : []),
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
  Advanced: ["policy", "desktop policies", "mdm", "lock", "marketplace", "branding"],
  Analytics: ["usage", "stats"],
  "API Keys": ["token", "secret"],
  Billing: ["plan", "invoice", "payment"],
  "Bring your Own Keys": ["llm", "provider", "byok", "api key"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  Dashboard: ["home", "overview"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "debug", "troubleshooting"],
  General: ["organization", "workspace"],
  Members: ["people", "users", "invite", "teams", "roles"],
  Models: ["llm", "provider", "byok", "api key"],
  "My Automations": ["schedule", "recurring", "tasks"],
  "My Library": ["skills", "plugins", "connections"],
  "OpenWork Models": ["llm", "provider", "managed", "inference"],
  "OpenWork Web": ["cloud", "sessions"],
  "Plugin Directory": ["skills", "plugins", "marketplace"],
  SCIM: ["provisioning", "directory", "users"],
  Settings: ["organization", "workspace"],
  SSO: ["single sign on", "saml", "oidc"],
  "Tool Tester": ["tools", "test", "mcp"],
  "Workflow Runs": ["workflows", "logs", "history"],
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
