import { getMcpServerName, isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "../../../app/cloud/import-state";
import type { PendingCloudPluginChange } from "../../../app/cloud/desktop-cloud-sync";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { EnablementResult } from "../../../app/extensions";
import type { DenExternalMcpConnection, DenOrgMarketplaceResolved, DenOrgPlugin } from "../../../app/lib/den";
import type { McpServerEntry } from "../../../app/types";
import { connectionNeedsReconnect } from "../connections/native-provider-connections";

export type ExtensionItemSource = "builtin" | "marketplace" | "org-connection" | "mcp-directory" | "skill";
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
  /** Installed cloud plugin that was removed from the organization marketplace. */
  removedUpstream?: boolean;
  orgMcpConnection?: DenExternalMcpConnection;
  mcpEntry?: McpDirectoryInfo;
  skill?: { name: string; description?: string; path: string };
};

export type ExtensionItemBuildInput = {
  quickConnect: McpDirectoryInfo[];
  mcpServers: McpServerEntry[];
  installedSkills: Array<{ name: string; description?: string; path: string }>;
  importedCloudPlugins: Record<string, CloudImportedPlugin>;
  pendingCloudPluginChanges?: Record<string, PendingCloudPluginChange>;
  cloudMarketplaces: DenOrgMarketplaceResolved[];
  orgMcpConnections?: DenExternalMcpConnection[];
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

export function isOrgMcpConnectionReady(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connected" | "connectedForMe" | "needsReconnect" | "missingFeatures">) {
  return connection.credentialMode === "shared" ? connection.connected : connection.connectedForMe && !connectionNeedsReconnect(connection);
}

export function orgMcpConnectionDescription(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connectedForMe" | "needsReconnect" | "missingFeatures">) {
  if (connection.credentialMode === "shared") return "One org account managed by your organization — the AI acts as it.";
  if (connection.connectedForMe && connectionNeedsReconnect(connection)) return "Reconnect your account to grant newly requested permissions.";
  if (connection.connectedForMe) return "Connected with your own account.";
  return "Available from your organization. Connect your own account to use it.";
}

export function orgMcpConnectionActionLabel(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connected" | "connectedForMe" | "needsReconnect" | "missingFeatures">) {
  if (connection.credentialMode === "shared") return "Managed by your organization";
  if (connection.connectedForMe && connectionNeedsReconnect(connection)) return "Reconnect";
  if (connection.connectedForMe) return "Connected";
  return "Connect your account";
}

export function isOrgMcpConnectionItem(item: ExtensionItem): item is ExtensionItem & { orgMcpConnection: DenExternalMcpConnection } {
  return item.source === "org-connection" && Boolean(item.orgMcpConnection);
}

function normalizeProviderKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function normalizeProviderUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function orgConnectionMatchesQuickEntry(connection: DenExternalMcpConnection, entry: McpDirectoryInfo) {
  const entryUrl = normalizeProviderUrl(entry.url);
  const connectionUrl = normalizeProviderUrl(connection.url);
  if (entryUrl && connectionUrl && entryUrl === connectionUrl) return true;

  const entryKeys = [entry.serverName ?? "", entry.name].map(normalizeProviderKey).filter(Boolean);
  const connectionKey = normalizeProviderKey(connection.name);
  return entryKeys.some((key) => key && key === connectionKey);
}

function orgConnectionCanRender(connection: DenExternalMcpConnection) {
  return connection.credentialMode === "per_member" || connection.connected;
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
  const externalMcpConnectionIds = new Set<string>();
  const skillPaths = new Set<string>();
  const skillNames = new Set<string>();
  for (const file of plugin.files) {
    if (file.path.startsWith(MCP_IMPORT_PATH_PREFIX)) {
      mcpServerNames.add(file.path.slice(MCP_IMPORT_PATH_PREFIX.length));
    }
    if (file.externalMcpConnectionId) {
      externalMcpConnectionIds.add(file.externalMcpConnectionId);
    }
    if (file.objectType === "skill") {
      skillPaths.add(file.path);
      const name = file.path.match(/^\.opencode\/skills\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/)?.[1];
      if (name) skillNames.add(name);
      skillNames.add(file.title);
    }
  }
  return { externalMcpConnectionIds, mcpServerNames, skillPaths, skillNames };
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
    const pendingChange = input.pendingCloudPluginChanges?.[plugin.id];
    const installState = imported && pendingChange === "modified" ? "update_available" : cloudPluginStatus(imported, plugin);
    const externalConnectionIds = new Set(imported?.files.flatMap((file) => file.externalMcpConnectionId ? [file.externalMcpConnectionId] : []) ?? []);
    const connectionStates = [...externalConnectionIds].flatMap((id) => {
      const connection = input.orgMcpConnections?.find((entry) => entry.id === id);
      return connection ? [isOrgMcpConnectionReady(connection)] : [false];
    });
    const connectionSetupState = connectionStates.length === 0
      ? null
      : connectionStates.every(Boolean)
        ? "ready"
        : "needs_setup";
    return {
      id: `marketplace:${marketplace.marketplace.id}:${plugin.id}`,
      source: "marketplace",
      name: plugin.extension?.name ?? plugin.name,
      description: plugin.extension?.description ?? plugin.description,
      installState,
      setupState: enablement ? setupStateFromEnablement(enablement) : installState === "available" ? "needs_setup" : connectionSetupState ?? "ready",
      active: enablement?.active ?? (installState !== "available" && connectionSetupState !== "needs_setup"),
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
      removedUpstream: input.pendingCloudPluginChanges?.[plugin.pluginId] === "removed",
    }];
  });

  const orgMcpConnectionItems = (input.orgMcpConnections ?? []).flatMap((connection): ExtensionItem[] => {
    if (!orgConnectionCanRender(connection)) return [];
    const ready = isOrgMcpConnectionReady(connection);
    return [{
      id: `org-mcp:${connection.id}`,
      source: "org-connection",
      name: connection.name,
      description: orgMcpConnectionDescription(connection),
      installState: ready ? "installed" : "available",
      setupState: ready ? "ready" : "needs_setup",
      active: ready,
      enablement: null,
      resources: [{ id: connection.id, type: "mcp", title: connection.name }],
      orgMcpConnection: connection,
    }];
  });

  const renderableOrgConnections = orgMcpConnectionItems.flatMap((item) => item.orgMcpConnection ? [item.orgMcpConnection] : []);
  const hasRenderableOrgEquivalent = (entry: McpDirectoryInfo) => {
    if (entry.type !== "remote") return false;
    if (input.mcpServers.some((server) => server.name === getMcpServerName(entry))) return false;
    return renderableOrgConnections.some((connection) => orgConnectionMatchesQuickEntry(connection, entry));
  };

  const groupedMcpServerNames = new Set<string>();
  const groupedExternalMcpConnectionIds = new Set<string>();
  const groupedSkillPaths = new Set<string>();
  const groupedSkillNames = new Set<string>();
  for (const plugin of Object.values(input.importedCloudPlugins)) {
    const keys = childKeysForPlugin(plugin);
    keys.externalMcpConnectionIds.forEach((value) => groupedExternalMcpConnectionIds.add(value));
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

  const visibleOrgMcpConnectionItems = orgMcpConnectionItems.filter((item) =>
    !item.orgMcpConnection || !groupedExternalMcpConnectionIds.has(item.orgMcpConnection.id));

  return {
    // Org-managed MCP connections are beta, so keep them last in unified lists.
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
    })), ...standaloneSkillItems, ...visibleOrgMcpConnectionItems],
    builtInItems,
    cloudPluginItems: [...cloudPluginItems, ...importedPluginItems],
    orgMcpConnectionItems: visibleOrgMcpConnectionItems,
    installedMcpEntries: [
      ...builtInItems.flatMap((item) => item.active && item.builtInEntry ? [item.builtInEntry] : []),
      ...standaloneMcpEntries,
    ],
    // The MCP quick-connect surface ("Available apps · One-click connect")
    // needs unconfigured directory entries too — otherwise Notion, Linear,
    // OpenWork Cloud Control, etc. are undiscoverable for anyone who is not
    // signed in to cloud (regression from #2008, which narrowed the section
    // to installed entries only).
    quickConnectEntries: [
      ...builtInItems.flatMap((item) => item.active && item.builtInEntry ? [item.builtInEntry] : []),
      ...standaloneMcpEntries,
      ...input.quickConnect.filter((entry) => {
        if (isBuiltInOpenWorkExtension(entry)) return false;
        const serverName = getMcpServerName(entry);
        if (groupedMcpServerNames.has(serverName)) return false;
        if (hasRenderableOrgEquivalent(entry)) return false;
        return !input.mcpServers.some((server) => server.name === serverName);
      }),
    ],
    installedSkills: standaloneSkillItems.flatMap((item) => item.skill ? [item.skill] : []),
    installedCloudPlugins: Object.values(input.importedCloudPlugins),
  };
}
