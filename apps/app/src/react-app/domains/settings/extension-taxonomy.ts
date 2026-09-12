import { isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import { t } from "../../../i18n";

/**
 * What a user sees on an inventory row:
 * - app: a runtime that runs on this device (Ollama, Computer Use, Browser)
 * - connection: an account, shared by an organization or signed in by the member
 * - mcp: an MCP server configured in this workspace
 * - skill / command / agent: composer capabilities managed in Library
 * - plugin: organization bundles
 */
export type ExtensionTaxonomy = "app" | "connection" | "mcp" | "skill" | "command" | "agent" | "plugin";

export type ExtensionInventoryFilter = "all" | ExtensionTaxonomy;

export type ExtensionTransport = "mcp" | "native" | null;

export type ExtensionInventoryState = "all" | "needs_signin" | "needs_admin_setup" | "ready" | "available" | "disabled";

export const extensionInventoryFilters: ExtensionInventoryFilter[] = [
  "mcp",
  "skill",
  "plugin",
];

/**
 * Legacy routes remain valid, but only these three categories are primary.
 * Commands and agents stay composer capabilities (/command, @agent) with
 * direct-link detail pages; their old routes land on Skills.
 */
export function primaryLibraryFilter(filter?: ExtensionInventoryFilter): ExtensionInventoryFilter {
  if (filter === "skill" || filter === "command" || filter === "agent") return "skill";
  return filter === "plugin" ? "plugin" : "mcp";
}

/** Built-ins ship with OpenWork and run here, so they are apps. Accounts arrive as org connections. */
export function taxonomyForDirectoryEntry(entry: McpDirectoryInfo): ExtensionTaxonomy {
  if (isBuiltInOpenWorkExtension(entry) || entry.kind === "ui-control") return "app";
  return "mcp";
}

/**
 * The MCPs category lists third-party servers only. OpenWork's own runtimes
 * (Computer Use, the browser panel, Ollama, UI control) and auto-managed
 * plumbing such as Cloud Control are app functionality, not MCPs to browse;
 * their setup pages stay reachable by direct link.
 */
export function isLibraryMcpDirectoryEntry(entry: McpDirectoryInfo): boolean {
  return taxonomyForDirectoryEntry(entry) === "mcp" && entry.defaultHidden !== true;
}

export function matchesExtensionFilter(
  filter: ExtensionInventoryFilter,
  taxonomy: ExtensionTaxonomy,
  transport: ExtensionTransport = null,
) {
  return filter === "all" || filter === taxonomy || (filter === "mcp" && (taxonomy === "connection" || transport === "mcp"));
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
