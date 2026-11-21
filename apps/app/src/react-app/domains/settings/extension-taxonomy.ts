import { isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import { t } from "../../../i18n";

export type ExtensionTaxonomy = "app" | "connection" | "mcp" | "skill" | "command" | "agent" | "plugin";

export type ExtensionInventoryFilter = "all" | ExtensionTaxonomy;

export type ExtensionTransport = "mcp" | "native" | null;

export type ExtensionInventoryState = "all" | "needs_signin" | "needs_admin_setup" | "ready" | "available" | "disabled";

export const extensionInventoryFilters: ExtensionInventoryFilter[] = [
  "all",
  "connection",
  "skill",
  "plugin",
];

export function primaryLibraryFilter(filter?: ExtensionInventoryFilter): ExtensionInventoryFilter {
  if (filter === "skill" || filter === "command" || filter === "agent") return "skill";
  if (filter === "connection" || filter === "mcp") return "connection";
  return filter === "plugin" ? "plugin" : "all";
}

export function taxonomyForDirectoryEntry(entry: McpDirectoryInfo): ExtensionTaxonomy {
  if (isBuiltInOpenWorkExtension(entry) || entry.kind === "ui-control") return "app";
  return "mcp";
}

export function isLibraryMcpDirectoryEntry(entry: McpDirectoryInfo): boolean {
  return taxonomyForDirectoryEntry(entry) === "mcp" && entry.defaultHidden !== true;
}

export function matchesExtensionFilter(
  filter: ExtensionInventoryFilter,
  taxonomy: ExtensionTaxonomy,
  transport: ExtensionTransport = null,
) {
  if (filter === "all" || filter === taxonomy) return true;
  const connector = taxonomy === "connection" || taxonomy === "mcp" || transport === "mcp";
  return (filter === "mcp" || filter === "connection") && connector;
}

export function extensionFilterLabel(filter: ExtensionInventoryFilter) {
  switch (filter) {
    case "all":
      return t("extensions.filter_all");
    case "app":
      return t("extensions.filter_apps");
    case "connection":
      return t("extensions.filter_connections");
    case "mcp":
      return t("extensions.filter_mcps");
    case "skill":
      return t("extensions.filter_skills");
    case "command":
      return t("extensions.filter_commands");
    case "agent":
      return t("extensions.filter_agents");
    case "plugin":
      return t("extensions.filter_plugins");
  }
}

export function extensionTaxonomyLabel(taxonomy: ExtensionTaxonomy) {
  switch (taxonomy) {
    case "app":
      return t("extensions.badge_app");
    case "connection":
      return t("extensions.badge_connection");
    case "mcp":
      return t("extensions.badge_mcp");
    case "skill":
      return t("extensions.badge_skill");
    case "command":
      return t("extensions.badge_command");
    case "agent":
      return t("extensions.badge_agent");
    case "plugin":
      return t("extensions.badge_plugin");
  }
}
