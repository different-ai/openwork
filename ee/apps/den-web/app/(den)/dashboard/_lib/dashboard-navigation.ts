import {
  BarChart3,
  Box,
  CalendarClock,
  Radar,
  Globe,
  Laptop,
  LibraryBig,
  LockKeyhole,
  MessageCircle,
  MonitorSmartphone,
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
  getAuthSecurityRoute,
  getAutomationsRoute,
  getBillingRoute,
  getConfigRoute,
  getComputersRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getDeploymentsRoute,
  getLibraryMyAgentRoute,
  getLibraryRoute,
  getMarketplacesRoute,
  getMcpConnectionsRoute,
  getMembersRoute,
  getMyComputersRoute,
  getOrgSettingsRoute,
  getPermissionsRoute,
  getPluginsRoute,
  getToolTesterRoute,
  getWebRoute,
  getWorkbotSettingsRoute,
} from "../../_lib/den-org";
import type { DenOrgMode } from "../../_lib/runtime-config";
import { canOpenAdminRoute } from "./admin-route-access";
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
  /** Quiet dot beside the label when something here is waiting on the viewer. */
  attention?: string;
  /** Quiet lock beside the label when someone else has to unblock this entry (DESIGN.md P4, C5). */
  locked?: string;
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
  /** The managedDeployments feature is on for this organization. */
  managedDeployments?: boolean;
  desktopPolicyScreenRemoved?: boolean;
  /** Workbot's settings are on Members › Teams › Everyone for this viewer, so Manage has no Workbot entry. */
  workbotSettingsInTeams?: boolean;
  /** Explicit server capability, independent of organization role permissions. */
  canManageDeploymentServices?: boolean;
  /** What clicking Workbot does; an entry without a provider stays visible with a marker, one turned off is hidden. */
  workbotEntry?: WorkbotEntry;
  /** The workspace on screen, so the Workbot entry opens Workbot for it. */
  organizationId?: string | null;
  /** The member's own agent is available to them (see myAgentAvailable). */
  myBot?: boolean;
};

export function buildDashboardNavSections({
  orgSlug,
  access,
  capabilities,
  runtimeConfigLoaded,
  libraryNeedsSignIn = 0,
  managedDeployments = false,
  desktopPolicyScreenRemoved = false,
  workbotSettingsInTeams = false,
  canManageDeploymentServices = false,
  workbotEntry = { kind: "open" },
  organizationId = null,
  myBot = false,
}: BuildDashboardNavSectionsInput): DashboardNavSection[] {
  const workflowsEnabled = capabilities.workflows;
  const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;
  // Workbot turned off for the viewer: no Workbot and no My bot in the menu.
  const workbotOff = workbotEntry.kind === "off";
  const workItems: DashboardNavItem[] = [
    ...(capabilities.workbot && !workbotOff
      ? [{ href: workbotEntryHref(organizationId), label: "Workbot", icon: MessageCircle, testId: "dashboard-nav-workbot", ...workbotNavMarker(workbotEntry) }]
      : []),
    ...(myBot && orgSlug && !workbotOff
      ? [{ href: getLibraryMyAgentRoute(orgSlug), label: "My bot", icon: Radar, testId: "dashboard-nav-my-bot" }]
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
    // Every member sees their own and shared computers; the team-wide list is Manage › Computers.
    ...(orgSlug
      ? [{ href: getMyComputersRoute(orgSlug), label: "My Computers", icon: MonitorSmartphone, testId: "dashboard-nav-my-computers" }]
      : []),
    ...(showWeb
      ? [{ href: orgSlug ? getWebRoute(orgSlug) : "#", label: "OpenWork Web", icon: Globe }]
      : []),
  ];

  // Admin-area entries appear only where the member holds the page's permission.
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
        ...permissionsNavChildren(orgSlug, access, canOpen(getMembersRoute(orgSlug))),
        ...authSecurityNavChildren(orgSlug, access),
        ...(canOpen(getMarketplacesRoute(orgSlug))
          ? [{ href: getMarketplacesRoute(orgSlug), label: "Advanced" }]
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

/** Roles live under Members, with a Settings entry only when Members is unavailable. */
function permissionsNavChildren(orgSlug: string, access: DenOrgAccessFlags, membersOpen: boolean): DashboardNavChild[] {
  return access.canViewPermissions && !membersOpen ? [{ href: getPermissionsRoute(orgSlug), label: "Roles" }] : [];
}

/** SSO and SCIM: one Auth & Security entry, shown when either tab is visible. */
function authSecurityNavChildren(orgSlug: string, access: DenOrgAccessFlags): DashboardNavChild[] {
  return access.canViewSso || access.canViewScim ? [{ href: getAuthSecurityRoute(orgSlug), label: "Auth & Security" }] : [];
}

// Alias order is ranking priority in the command palette.
const PAGE_KEYWORDS: Record<string, string[]> = {
  Advanced: ["marketplace", "collections", "branding", "brand appearance"],
  "AI Gateway": ["llm", "provider", "gateway", "inference", "usage"],
  Analytics: ["usage", "stats", "workflow runs", "history"],
  "Audit logs": ["audit", "history", "operations", "changes", "security"],
  "API Keys": ["token", "secret"],
  "Auth & Security": ["sso", "single sign on", "saml", "oidc", "scim", "provisioning", "directory", "okta", "entra", "identity provider"],
  Billing: ["plan", "invoice", "payment"],
  Config: ["export", "import", "backup", "json", "copy settings", "change requests", "revert"],
  "Bring Your Own Keys (Legacy)": ["llm", "provider", "byok", "api key"],
  Computers: ["devices", "team computers", "desktop", "virtual computers", "inventory", "owners", "remote access", "other devices"],
  Connectors: ["mcp", "integrations", "servers", "connect"],
  "Desktop policies": ["policy", "mdm", "lock", "desktop"],
  Deployments: ["aws", "self-hosted", "byoc", "install", "health", "status"],
  Dashboards: ["boards", "apps"],
  Diagnostics: ["health", "status", "services", "readiness", "debug", "troubleshooting", "desktop startup"],
  General: ["organization", "workspace"],
  // Agent permissions live on Members › Teams (Everyone and each team's Agents tab).
  Members: ["people", "users", "invite", "teams", "roles", "agent permissions", "commands", "websites", "allow list", "block list", "desktop", "prompt suggestions"],
  Models: ["llm", "provider", "byok", "api key"],
  Permissions: ["access", "roles", "teams", "admin", "rbac"],
  "My Automations": ["schedule", "recurring", "tasks"],
  "My Computers": ["devices", "my devices", "laptop", "desktop", "virtual computers", "workbot computer", "remote access", "other devices", "tasks"],
  "My bot": ["agent", "my agent", "morning brief", "meeting prep", "proactive", "notifications"],
  "My Library": ["skills", "plugins", "connections"],
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
