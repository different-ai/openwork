import { isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import { t } from "../../../i18n";

/**
 * What a user sees on an inventory row:
 * - app: a runtime that runs on this device (Ollama, Computer Use, Browser, Voice)
 * - connection: an account, shared by an organization or signed in by the member
 * - mcp: an MCP server configured in this workspace
 * - skill / plugin: installed workflows and organization bundles
 */
export type ExtensionTaxonomy = "app" | "connection" | "mcp" | "skill" | "plugin";

export type ExtensionInventoryFilter = "all" | ExtensionTaxonomy;

export type ExtensionTransport = "mcp" | "native" | null;

export type ExtensionInventoryState = "all" | "needs_signin" | "needs_admin_setup" | "ready";

export const extensionInventoryFilters: ExtensionInventoryFilter[] = [
  "all",
  "app",
  "connection",
  "mcp",
  "skill",
  "plugin",
];

/** Built-ins ship with OpenWork and run here, so they are apps. Accounts arrive as org connections. */
export function taxonomyForDirectoryEntry(entry: McpDirectoryInfo): ExtensionTaxonomy {
  if (isBuiltInOpenWorkExtension(entry) || entry.kind === "ui-control") return "app";
  return "mcp";
}

export function matchesExtensionFilter(
  filter: ExtensionInventoryFilter,
  taxonomy: ExtensionTaxonomy,
  transport: ExtensionTransport = null,
) {
  return filter === "all" || filter === taxonomy || (filter === "mcp" && transport === "mcp");
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
    case "plugin":
      return t("extensions.badge_plugin");
  }
}
