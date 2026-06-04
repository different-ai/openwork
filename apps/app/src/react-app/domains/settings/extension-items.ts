import { getMcpServerName, isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "../../../app/cloud/import-state";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { EnablementResult } from "../../../app/extensions";
import type { DenOrgMarketplaceResolved, DenOrgPlugin } from "../../../app/lib/den";
import type { McpServerEntry } from "../../../app/types";

export type ExtensionItemSource = "builtin" | "marketplace" | "mcp-directory" | "skill";
export type ExtensionInstallState = "available" | "installed" | "update_available";
export type ExtensionSetupState = "ready" | "needs_setup" | "partial";

export type ExtensionResourceItem = {
  id: string;
  type: string;
  title: string;
  path?: string;
};

export type ExtensionItem = {
  id: string;
  source: ExtensionItemSource;
  name: string;
  description: string | null;
  installState: ExtensionInstallState;
  setupState: ExtensionSetupState;
  active: boolean;
  enablement: { active: boolean; results: EnablementResult[] } | null;
  resources: ExtensionResourceItem[];
  builtInEntry?: McpDirectoryInfo;
  marketplaceId?: string | null;
  marketplaceName?: string;
  plugin?: DenOrgPlugin;
  importedPlugin?: CloudImportedPlugin;
  mcpEntry?: McpDirectoryInfo;
  skill?: { name: string; description?: string; path: string };
};

export type ExtensionItemBuildInput = {
  quickConnect: McpDirectoryInfo[];
  mcpServers: McpServerEntry[];
  installedSkills: Array<{ name: string; description?: string; path: string }>;
  importedCloudPlugins: Record<string, CloudImportedPlugin>;
  cloudMarketplaces: DenOrgMarketplaceResolved[];
  enablementContext: EnablementContext;
  isBuiltInConnected: (entry: McpDirectoryInfo) => boolean;
};

const MCP_IMPORT_PATH_PREFIX = "opencode.jsonc#mcp.";

export function isToggleControlledExtension(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.enablement?.some((condition) => condition.type === "toggle-enabled") === true;
}

function setupStateFromEnablement(enablement: { active: boolean; results: EnablementResult[] } | null): ExtensionSetupState {
  if (!enablement || enablement.results.length === 0) return "needs_setup";
  if (enablement.active) return "ready";
  return enablement.results.some((result) => result.met) ? "partial" : "needs_setup";
}

function cloudPluginStatus(imported: CloudImportedPlugin | null, plugin: DenOrgPlugin): ExtensionInstallState {
  if (!imported) return "available";
  const importedObjectCount = new Set(imported.files.map((file) => file.configObjectId)).size;
  if (imported.updatedAt !== plugin.updatedAt || importedObjectCount !== plugin.memberCount) return "update_available";
  return "installed";
}

function resourceFromImportedFile(file: CloudImportedPluginFile): ExtensionResourceItem {
  return {
    id: file.configObjectId,
    type: file.objectType,
    title: file.title,
    path: file.path,
  };
}

function childKeysForPlugin(plugin: CloudImportedPlugin) {
  const mcpServerNames = new Set<string>();
  const skillPaths = new Set<string>();
  const skillNames = new Set<string>();
  for (const file of plugin.files) {
    if (file.path.startsWith(MCP_IMPORT_PATH_PREFIX)) {
      mcpServerNames.add(file.path.slice(MCP_IMPORT_PATH_PREFIX.length));
    }
    if (file.objectType === "skill") {
      skillPaths.add(file.path);
      const name = file.path.match(/^\.opencode\/skills\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/)?.[1];
      if (name) skillNames.add(name);
      skillNames.add(file.title);
    }
  }
  return { mcpServerNames, skillPaths, skillNames };
}

export function buildExtensionItems(input: ExtensionItemBuildInput) {
  const builtInItems = input.quickConnect.filter(isBuiltInOpenWorkExtension).map((entry): ExtensionItem => {
    const enablement = entry.extensionManifest?.enablement
      ? evaluateEnablement(entry.extensionManifest.enablement, input.enablementContext)
      : null;
    const active = enablement?.active ?? input.isBuiltInConnected(entry);
    return {
      id: `builtin:${entry.id ?? entry.serverName ?? entry.name}`,
      source: "builtin",
      name: entry.name,
      description: entry.description,
      installState: active ? "installed" : "available",
      setupState: enablement ? setupStateFromEnablement(enablement) : active ? "ready" : "needs_setup",
      active,
      enablement,
      resources: entry.extensionManifest?.resources.map((resource) => ({
        id: resource.id,
        type: resource.type,
        title: resource.label ?? resource.id,
        path: resource.path,
      })) ?? [],
      builtInEntry: entry,
    };
  });

  const cloudPluginItems = input.cloudMarketplaces.flatMap((marketplace) => marketplace.plugins.map((plugin): ExtensionItem => {
    const imported = input.importedCloudPlugins[plugin.id] ?? null;
    const manifest = plugin.extension?.manifest ?? undefined;
    const enablement = manifest?.enablement ? evaluateEnablement(manifest.enablement, input.enablementContext) : null;
    const installState = cloudPluginStatus(imported, plugin);
    return {
      id: `marketplace:${marketplace.marketplace.id}:${plugin.id}`,
      source: "marketplace",
      name: plugin.extension?.name ?? plugin.name,
      description: plugin.extension?.description ?? plugin.description,
      installState,
      setupState: enablement ? setupStateFromEnablement(enablement) : installState === "available" ? "needs_setup" : "ready",
      active: enablement?.active ?? installState !== "available",
      enablement,
      resources: imported?.files.map(resourceFromImportedFile) ?? Object.entries(plugin.componentCounts).flatMap(([type, count]) => count > 0 ? [{
        id: `${plugin.id}:${type}`,
        type,
        title: `${count} ${type}${count === 1 ? "" : "s"}`,
      }] : []),
      marketplaceId: marketplace.marketplace.id,
      marketplaceName: marketplace.marketplace.name,
      plugin,
      importedPlugin: imported,
    };
  }));

  const importedPluginItems = Object.values(input.importedCloudPlugins).flatMap((plugin): ExtensionItem[] => {
    if (cloudPluginItems.some((item) => item.importedPlugin?.pluginId === plugin.pluginId)) return [];
    return [{
      id: `marketplace:installed:${plugin.pluginId}`,
      source: "marketplace",
      name: plugin.name,
      description: plugin.description,
      installState: "installed",
      setupState: "ready",
      active: true,
      enablement: null,
      resources: plugin.files.map(resourceFromImportedFile),
      marketplaceId: plugin.marketplaceId,
      importedPlugin: plugin,
    }];
  });

  const groupedMcpServerNames = new Set<string>();
  const groupedSkillPaths = new Set<string>();
  const groupedSkillNames = new Set<string>();
  for (const plugin of Object.values(input.importedCloudPlugins)) {
    const keys = childKeysForPlugin(plugin);
    keys.mcpServerNames.forEach((value) => groupedMcpServerNames.add(value));
    keys.skillPaths.forEach((value) => groupedSkillPaths.add(value));
    keys.skillNames.forEach((value) => groupedSkillNames.add(value));
  }

  const standaloneMcpEntries = input.quickConnect.filter((entry) => {
    if (isBuiltInOpenWorkExtension(entry)) return false;
    const serverName = getMcpServerName(entry);
    if (groupedMcpServerNames.has(serverName)) return false;
    return input.mcpServers.some((server) => server.name === serverName);
  });

  const standaloneSkillItems = input.installedSkills.filter((skill) => {
    if ([...groupedSkillPaths].some((path) => skill.path.endsWith(path))) return false;
    if (groupedSkillNames.has(skill.name)) return false;
    return true;
  }).map((skill): ExtensionItem => ({
    id: `skill:${skill.name}`,
    source: "skill",
    name: skill.name,
    description: skill.description ?? null,
    installState: "installed",
    setupState: "ready",
    active: true,
    enablement: null,
    resources: [{ id: skill.name, type: "skill", title: skill.name, path: skill.path }],
    skill,
  }));

  return {
    items: [...builtInItems, ...cloudPluginItems, ...importedPluginItems, ...standaloneMcpEntries.map((entry): ExtensionItem => ({
      id: `mcp:${getMcpServerName(entry)}`,
      source: "mcp-directory",
      name: entry.name,
      description: entry.description,
      installState: "installed",
      setupState: "ready",
      active: true,
      enablement: null,
      resources: [{ id: getMcpServerName(entry), type: "mcp", title: entry.name }],
      mcpEntry: entry,
    })), ...standaloneSkillItems],
    builtInItems,
    cloudPluginItems: [...cloudPluginItems, ...importedPluginItems],
    installedMcpEntries: [
      ...builtInItems.flatMap((item) => item.builtInEntry ? [item.builtInEntry] : []),
      ...standaloneMcpEntries,
    ],
    installedSkills: standaloneSkillItems.flatMap((item) => item.skill ? [item.skill] : []),
    installedCloudPlugins: Object.values(input.importedCloudPlugins),
  };
}
