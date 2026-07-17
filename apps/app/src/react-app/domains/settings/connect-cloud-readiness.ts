import type {
  DenExternalMcpConnection,
  DenOrgPlugin,
  DenOrgSummary,
  DenPluginCloudReadiness,
} from "@/app/lib/den";
import { t } from "@/i18n";
import { connectionNeedsReconnect } from "@/react-app/domains/connections/native-provider-connections";

export type ConnectRowGroup = "needs_signin" | "ready" | "needs_admin_setup" | "excluded";
export type ConnectOrgRole = DenOrgSummary["role"] | null | undefined;

const instructionalTypes = new Set(["agent", "command", "context", "custom", "skill"]);
const desktopInstallTypes = new Set(["hook", "tool"]);

export function isConnectAdminRole(role: ConnectOrgRole) {
  return role === "owner" || role === "admin";
}

export function pluginHasInstructionalComponents(componentCounts: Record<string, number>) {
  return Object.entries(componentCounts).some(([type, count]) => count > 0 && instructionalTypes.has(type));
}

export function pluginHasDesktopInstallComponents(plugin: Pick<DenOrgPlugin, "componentCounts" | "extension">) {
  if (Object.entries(plugin.componentCounts).some(([type, count]) => count > 0 && desktopInstallTypes.has(type))) return true;
  return plugin.extension?.manifest?.resources.some((resource) => desktopInstallTypes.has(resource.type)) === true;
}

export function isDesktopInstallableMarketplacePlugin(plugin: Pick<DenOrgPlugin, "cloudReadiness" | "componentCounts" | "extension">) {
  const readiness = plugin.cloudReadiness;
  if (!readiness) return pluginHasDesktopInstallComponents(plugin);
  return readiness.state === "desktop_only" || readiness.state === "not_synced";
}

export function resolveConnectRowGroup(
  readiness: DenPluginCloudReadiness | null | undefined,
  role: ConnectOrgRole,
  componentCounts: Record<string, number> = {},
): ConnectRowGroup {
  if (!readiness) return pluginHasInstructionalComponents(componentCounts) ? "ready" : "excluded";
  switch (readiness.state) {
    case "ready":
      return "ready";
    case "needs_signin":
      return "needs_signin";
    case "needs_admin_setup":
      return isConnectAdminRole(role) ? "needs_admin_setup" : "excluded";
    case "desktop_only":
    case "not_synced":
      return "excluded";
  }
}

export function resolveConnectionRowGroup(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connectedForMe" | "needsReconnect" | "missingFeatures" | "reconnectActionOwner">): Exclude<ConnectRowGroup, "excluded"> {
  if (connection.needsReconnect && connection.reconnectActionOwner === "organization_admin") return "needs_admin_setup";
  if (connection.credentialMode === "per_member" && (!connection.connectedForMe || connectionNeedsReconnect(connection))) return "needs_signin";
  return "ready";
}

function componentTypeLabel(type: string, count: number) {
  switch (type) {
    case "agent":
      return t("connect.row_component_agent", { count });
    case "command":
      return t("connect.row_component_command", { count });
    case "context":
      return t("connect.row_component_context", { count });
    case "custom":
      return t("connect.row_component_custom", { count });
    case "mcp":
      return t("connect.row_component_mcp", { count });
    case "skill":
      return t("connect.row_component_skill", { count });
    case "hook":
      return t("connect.row_component_hook", { count });
    case "tool":
      return t("connect.row_component_tool", { count });
    default:
      return type;
  }
}

export function formatPluginComponentMeta(componentCounts: Record<string, number>) {
  const labels = Object.entries(componentCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => t("connect.row_component_count", { count, type: componentTypeLabel(type, count) }));
  return labels.length > 0 ? labels.join(t("connect.row_meta_separator")) : t("connect.row_meta_no_components");
}

export function cloudReadinessConnectableConnectionId(readiness: DenPluginCloudReadiness | null | undefined) {
  return readiness?.connections.find((connection) => connection.id && connection.credentialMode === "per_member" && connection.connectedForMe === false)?.id ?? null;
}

export function cloudReadinessMissingConnectionNames(readiness: DenPluginCloudReadiness | null | undefined) {
  return readiness?.connections.flatMap((connection) => connection.id === null ? [connection.name] : []) ?? [];
}

export function formatPluginConnectRowMeta(plugin: Pick<DenOrgPlugin, "cloudReadiness" | "componentCounts">) {
  if (plugin.cloudReadiness?.state === "needs_admin_setup") {
    const missing = cloudReadinessMissingConnectionNames(plugin.cloudReadiness);
    if (plugin.cloudReadiness.hasInstructional) {
      const setupNames = missing.length > 0 ? `${t("connect.row_meta_separator")}${t("connect.row_meta_needs_setup_names", { names: missing.join(t("connect.row_meta_list_separator")) })}` : "";
      return `${t("connect.row_meta_instructional_needs_setup")}${setupNames}`;
    }
    if (missing.length > 0) return t("connect.row_meta_needs_setup_names", { names: missing.join(t("connect.row_meta_list_separator")) });
  }
  return formatPluginComponentMeta(plugin.componentCounts);
}
