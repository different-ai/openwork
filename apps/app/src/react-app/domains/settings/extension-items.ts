import { getMcpServerName, isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../app/constants";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "../../../app/cloud/import-state";
import type { PendingCloudPluginChange } from "../../../app/cloud/desktop-cloud-sync";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { EnablementResult } from "../../../app/extensions";
import type {
  DenExternalMcpConnection,
  DenOrgMarketplaceResolved,
  DenOrgPlugin,
  DenPluginCloudReadiness,
} from "../../../app/lib/den";
import type { McpServerEntry, SkillCard } from "../../../app/types";
import { connectionNeedsReconnect } from "../connections/native-provider-connections";
import {
  resolveConnectRowGroup,
  resolveConnectionRowGroup,
  type ConnectOrgRole,
} from "./connect-cloud-readiness";

export type ExtensionItemSource = "builtin" | "marketplace" | "org-connection" | "mcp-directory" | "skill";
export type ExtensionInstallState = "available" | "installed" | "update_available";
export type ExtensionSetupState = "ready" | "needs_setup" | "partial";
export type ExtensionInventoryGroup = "needs_signin" | "needs_admin_setup" | "ready" | "available" | "disabled";

export type ResolveExtensionInventoryGroupOptions = {
  role?: ConnectOrgRole;
  disabledReason?: string | null;
  cloudReadiness?: DenPluginCloudReadiness | null;
};

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

/**
 * Map an inventory item into the unified Extensions readiness groups.
 * Org/cloud readiness wins when present; otherwise fall back to install state.
 */
export function resolveExtensionInventoryGroup(
  item: ExtensionItem,
  opts: ResolveExtensionInventoryGroupOptions = {},
): ExtensionInventoryGroup {
  if (opts.disabledReason) return "disabled";

  if (item.orgMcpConnection) {
    return resolveConnectionRowGroup(item.orgMcpConnection);
  }

  const readiness = opts.cloudReadiness ?? item.plugin?.cloudReadiness;
  if (item.source === "marketplace" || readiness) {
    const group = resolveConnectRowGroup(
      readiness,
      opts.role,
      item.plugin?.componentCounts ?? {},
    );
    if (group === "needs_signin" || group === "needs_admin_setup" || group === "ready") {
      return group;
    }
  }

  if (item.installState === "available") return "available";
  return "ready";
}

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
const OPENWORK_PROVIDED_SKILL_NAMES = new Set([
  "workspace-guide",
  "skill-creator",
]);

export function isOpenworkProvidedSkill(skill: Pick<SkillCard, "name" | "path">) {
  const normalizedName = skill.name.trim().toLowerCase();
  const normalizedPath = skill.path.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.includes("/.opencode/skills/") &&
    OPENWORK_PROVIDED_SKILL_NAMES.has(normalizedName);
}

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

/** Human name of the service behind a native connector, so a card named "Acme Labs" still says what it signs in to. */
export function nativeProviderDisplayName(nativeProviderKey: string | null | undefined): string | null {
  if (nativeProviderKey === "google-workspace") return "Google Workspace";
  if (nativeProviderKey === "microsoft-365") return "Microsoft 365";
  return null;
}

export function orgMcpConnectionDescription(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connectedForMe" | "needsReconnect" | "missingFeatures" | "nativeProviderKey" | "externalAccountId">) {
  const provider = nativeProviderDisplayName(connection.nativeProviderKey);
  const prefix = provider ? `${provider} — ` : "";
  if (connection.credentialMode === "shared") return `${prefix}One org account managed by your organization — the AI acts as it.`;
  if (connection.connectedForMe && connectionNeedsReconnect(connection)) return `${prefix}Reconnect your account to grant newly requested permissions.`;
  if (connection.connectedForMe) {
    // Keep the base sentence intact as a prefix: specs and people both read it.
    const account = connection.externalAccountId;
    return account
      ? `${prefix}Connected with your own account. Signed in as ${account}.`
      : `${prefix}Connected with your own account.`;
  }
  return `${prefix}Available from your organization. Connect your own account to use it.`;
}

export function orgMcpConnectionActionLabel(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connected" | "connectedForMe" | "needsReconnect" | "missingFeatures" | "externalAccountId">) {
  if (connection.credentialMode === "shared") return "Managed by your organization";
  if (connection.connectedForMe && connectionNeedsReconnect(connection)) return "Reconnect";
  if (connection.connectedForMe) {
    // Show WHICH account: with several connectors for one service (two Google
    // domains), a bare "Connected" badge cannot tell the sign-ins apart.
    return connection.externalAccountId ? `Connected — ${connection.externalAccountId}` : "Connected";
  }
  return "Connect your account";
}

export function isOrgMcpConnectionItem(item: ExtensionItem): item is ExtensionItem & { orgMcpConnection: DenExternalMcpConnection } {
  return item.source === "org-connection" && Boolean(item.orgMcpConnection);
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
    // Extensions is an inventory, not a browse catalog: built-ins always show
    // so they can be turned on, and everything else only shows once it is
    // configured here. Third-party connections arrive through the organization.
    quickConnectEntries: [
      ...builtInItems.flatMap((item) => item.builtInEntry ? [item.builtInEntry] : []),
      ...standaloneMcpEntries,
    ],
    installedSkills: standaloneSkillItems.flatMap((item) => item.skill ? [item.skill] : []),
    installedCloudPlugins: Object.values(input.importedCloudPlugins),
  };
}
