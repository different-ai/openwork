import { mcpAppProjectionSchema } from "@openwork/types/mcp-app";
import type { CloudImportedPlugin } from "@/app/cloud/import-state";
import type {
  DenAssignedMarketplaceCapability,
  DenMeLibraryPlugin,
  DenOrgMarketplace,
  DenOrgMarketplaceResolved,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginCloudReadinessConnection,
  DenPluginConfigObject,
} from "@/app/lib/den";
import type { McpServerEntry, McpStatus, McpStatusMap, SkillCard } from "@/app/types";

export type ConnectCapabilityClient = {
  listAssignedMarketplaceCapabilities: (
    organizationId: string,
  ) => Promise<DenAssignedMarketplaceCapability[]>;
  listMeLibraryPlugins?: (organizationId: string) => Promise<DenMeLibraryPlugin[]>;
  listOrgMarketplaces: (organizationId: string) => Promise<DenOrgMarketplace[]>;
  getOrgMarketplaceResolved: (
    organizationId: string,
    marketplaceId: string,
  ) => Promise<DenOrgMarketplaceResolved>;
  getOrgPluginResolved: (
    organizationId: string,
    plugin: DenOrgPlugin,
  ) => Promise<DenOrgPluginResolved>;
};

export type ConnectPluginFile = {
  configObjectId: string;
  objectType: string;
  title: string;
  path: string;
  versionId: string | null;
  updatedAt: string | null;
  skillName?: string;
  skillOrigin?: "openwork-connect";
  marketplaceName?: string;
  pluginName?: string;
  connectCapabilityName?: string;
};

export type ConnectPluginCard = {
  pluginId: string;
  marketplaceId: string;
  marketplaceName: string;
  name: string;
  description: string | null;
  files: ConnectPluginFile[];
};

export type ConnectCapabilityInventory = {
  skills: ConnectSkillCard[];
  plugins: ConnectPluginCard[];
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
};

export type ConnectSkillCard = SkillCard & {
  content?: string;
};

export const EMPTY_CONNECT_CAPABILITY_INVENTORY: ConnectCapabilityInventory = {
  skills: [],
  plugins: [],
  mcpServers: [],
  mcpStatuses: {},
};

export function connectPluginsForComposer(plugins: ConnectPluginCard[]): CloudImportedPlugin[] {
  return plugins.map((plugin) => ({
    pluginId: plugin.pluginId,
    marketplaceId: plugin.marketplaceId,
    name: plugin.name,
    description: plugin.description,
    updatedAt: null,
    importedAt: null,
    files: plugin.files.map((file) => ({
      configObjectId: file.configObjectId,
      versionId: file.versionId,
      objectType: file.objectType,
      title: file.title,
      path: file.path,
      updatedAt: file.updatedAt,
      skillName: file.skillName,
      skillOrigin: file.skillOrigin,
      marketplaceName: file.marketplaceName,
      pluginName: file.pluginName,
      connectCapabilityName: file.connectCapabilityName,
    })),
  }));
}

type MarketplacePlugin = {
  marketplace: DenOrgMarketplace;
  plugin: DenOrgPlugin;
};

type RemoteMcpSpec = {
  name: string;
  url: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function marketplaceCapabilityName(pluginId: string, configObjectId: string) {
  return `plugin:${pluginId}:${configObjectId}`;
}

function skillTrigger(object: DenPluginConfigObject) {
  const path = object.currentRelativePath?.replaceAll("\\", "/");
  return path?.match(/(?:^|\/)skills?\/([^/]+)\/SKILL\.md$/i)?.[1];
}

function remoteMcpSpecs(object: DenPluginConfigObject): RemoteMcpSpec[] {
  const payload = object.latestVersion?.normalizedPayloadJson;
  if (!payload) return [{ name: object.title, url: "" }];
  const servers = isRecord(payload.mcpServers) ? payload.mcpServers : null;
  if (servers) {
    const specs = Object.entries(servers).flatMap(([name, config]) => {
      if (!isRecord(config) || typeof config.url !== "string" || !config.url.trim()) return [];
      return [{ name: name.trim() || object.title, url: config.url.trim() }];
    });
    if (specs.length > 0) return specs;
  }
  return typeof payload.url === "string" && payload.url.trim()
    ? [{ name: object.title, url: payload.url.trim() }]
    : [{ name: object.title, url: "" }];
}

function matchingConnection(
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
  spec: RemoteMcpSpec,
): DenPluginCloudReadinessConnection | undefined {
  const connections = plugin.cloudReadiness?.connections ?? [];
  return connections.find((connection) =>
    connection.configObjectId === object.id && connection.serverName === spec.name
  ) ?? (spec.url ? connections.find((connection) => connection.url === spec.url) : undefined);
}

function remoteMcpStatus(
  plugin: DenOrgPlugin,
  connection: DenPluginCloudReadinessConnection | undefined,
): McpStatus {
  if (connection?.connectedForMe || plugin.cloudReadiness?.state === "ready") {
    return { status: "connected" };
  }
  if (plugin.cloudReadiness?.state === "needs_signin") {
    return { status: "needs_auth" };
  }
  return {
    status: "failed",
    error: plugin.cloudReadiness?.state === "needs_admin_setup"
      ? "Organization setup is required."
      : plugin.cloudReadiness?.state === "not_synced"
        ? "Marketplace content has not synced yet."
        : "This OpenWork Connect capability is not ready.",
  };
}

function toSkill(
  marketplace: DenOrgMarketplace,
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
): ConnectSkillCard {
  return {
    name: object.title,
    path: `openwork-connect://${marketplace.id}/${plugin.id}/${object.id}`,
    description: object.description ?? undefined,
    content: object.latestVersion?.rawSourceText ?? undefined,
    trigger: skillTrigger(object),
    origin: "openwork-connect",
    marketplaceName: marketplace.name,
    pluginName: plugin.name,
    connectCapabilityName: marketplaceCapabilityName(plugin.id, object.id),
  };
}

function toMcpEntries(
  marketplace: DenOrgMarketplace,
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
): Array<{ entry: McpServerEntry; status: McpStatus }> {
  const specs = remoteMcpSpecs(object);
  return specs.map((spec) => {
    const id = `openwork-connect:${plugin.id}:${object.id}:${spec.name}`;
    const displayName = specs.length === 1 ? object.title : `${object.title} · ${spec.name}`;
    const connection = matchingConnection(plugin, object, spec);
    const orgMcpConnectionId = connection?.id?.trim();
    return {
      entry: {
        id,
        name: displayName,
        config: { type: "remote", url: spec.url },
        origin: "openwork-connect",
        marketplaceName: marketplace.name,
        pluginName: plugin.name,
        connectCapabilityName: marketplaceCapabilityName(plugin.id, object.id),
        orgMcpConnectionId: orgMcpConnectionId || undefined,
      },
      status: remoteMcpStatus(plugin, connection),
    };
  });
}

const MEMBER_LIBRARY_MARKETPLACE: DenOrgMarketplace = {
  id: "me-library",
  name: "Library",
  description: null,
  status: "active",
  pluginCount: 0,
  updatedAt: null,
};

function pluginFromLibraryItem(item: DenMeLibraryPlugin): DenOrgPlugin {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    status: "active",
    memberCount: 0,
    updatedAt: null,
    componentCounts: {},
  };
}

export async function listAssignedConnectCapabilities(input: {
  client: ConnectCapabilityClient;
  organizationId: string;
}): Promise<ConnectCapabilityInventory> {
  const [assigned, libraryPlugins] = await Promise.all([
    input.client.listAssignedMarketplaceCapabilities(input.organizationId),
    input.client.listMeLibraryPlugins
      ? input.client.listMeLibraryPlugins(input.organizationId).catch(() => [])
      : Promise.resolve([]),
  ]);

  const assignedMarketplaceIds = new Set(
    assigned.flatMap((item) => item.marketplaceId ? [item.marketplaceId] : []),
  );
  const assignedPluginKeys = new Set(
    assigned.flatMap((item) => item.marketplaceId ? [`${item.marketplaceId}:${item.pluginId}`] : []),
  );
  const assignedCapabilityKeys = new Set(
    assigned.flatMap((item) => (
      item.marketplaceId ? [`${item.marketplaceId}:${item.pluginId}:${item.configObjectId}`] : []
    )),
  );
  const marketplaces = assigned.length === 0
    ? []
    : (await input.client.listOrgMarketplaces(input.organizationId))
      .filter((marketplace) => marketplace.status === "active")
      .filter((marketplace) => assignedMarketplaceIds.has(marketplace.id))
      .sort((left, right) => left.name.localeCompare(right.name));
  const resolvedMarketplaces = await Promise.all(
    marketplaces.map((marketplace) =>
      input.client.getOrgMarketplaceResolved(input.organizationId, marketplace.id)
    ),
  );

  const plugins = new Map<string, MarketplacePlugin>();
  for (const resolved of resolvedMarketplaces) {
    for (const plugin of resolved.plugins) {
      if (
        plugin.status !== "active"
        || plugins.has(plugin.id)
        || !assignedPluginKeys.has(`${resolved.marketplace.id}:${plugin.id}`)
      ) continue;
      plugins.set(plugin.id, { marketplace: resolved.marketplace, plugin });
    }
  }
  for (const item of libraryPlugins) {
    if (plugins.has(item.id)) continue;
    plugins.set(item.id, {
      marketplace: MEMBER_LIBRARY_MARKETPLACE,
      plugin: pluginFromLibraryItem(item),
    });
  }
  if (plugins.size === 0) return EMPTY_CONNECT_CAPABILITY_INVENTORY;

  const resolvedPlugins = await Promise.all(
    [...plugins.values()].map(async ({ marketplace, plugin }) => ({
      marketplace,
      resolved: await input.client.getOrgPluginResolved(input.organizationId, plugin),
    })),
  );

  const skills: SkillCard[] = [];
  const pluginsById = new Map<string, ConnectPluginCard>();
  const mcpServers: McpServerEntry[] = [];
  const mcpStatuses: McpStatusMap = {};
  for (const { marketplace, resolved } of resolvedPlugins) {
    const pluginCard: ConnectPluginCard = pluginsById.get(resolved.plugin.id) ?? {
      pluginId: resolved.plugin.id,
      marketplaceId: marketplace.id,
      marketplaceName: marketplace.name,
      name: resolved.plugin.name,
      description: resolved.plugin.description,
      files: [],
    };
    for (const membership of resolved.memberships) {
      const object = membership.configObject;
      const fromMemberLibrary = marketplace.id === MEMBER_LIBRARY_MARKETPLACE.id;
      if (!object || object.status !== "active") continue;
      if (
        !fromMemberLibrary
        && !assignedCapabilityKeys.has(`${marketplace.id}:${resolved.plugin.id}:${object.id}`)
      ) continue;
      if (object.objectType === "skill") {
        const skill = toSkill(marketplace, resolved.plugin, object);
        skills.push(skill);
        pluginCard.files.push({
          configObjectId: object.id,
          objectType: object.objectType,
          title: object.title,
          path: skill.path,
          versionId: object.latestVersion?.id ?? null,
          updatedAt: object.updatedAt,
          skillName: skill.name,
          skillOrigin: "openwork-connect",
          marketplaceName: skill.marketplaceName,
          pluginName: skill.pluginName,
          connectCapabilityName: skill.connectCapabilityName,
        });
      } else if (object.objectType === "app") {
        const app = mcpAppProjectionSchema.strip().safeParse(object.latestVersion?.normalizedPayloadJson);
        if (!app.success || app.data.appId !== object.id || app.data.revisionId !== object.latestVersion?.id) continue;
        pluginCard.files.push({
          configObjectId: object.id,
          objectType: "app",
          title: app.data.title,
          path: `openwork-connect://${marketplace.id}/${resolved.plugin.id}/${object.id}`,
          versionId: app.data.revisionId,
          updatedAt: object.updatedAt,
          marketplaceName: marketplace.name,
          pluginName: resolved.plugin.name,
        });
      } else if (object.objectType === "command" || object.objectType === "agent") {
        pluginCard.files.push({
          configObjectId: object.id,
          objectType: object.objectType,
          title: object.title,
          path: `openwork-connect://${marketplace.id}/${resolved.plugin.id}/${object.id}`,
          versionId: object.latestVersion?.id ?? null,
          updatedAt: object.updatedAt,
        });
      }
      if (object.objectType === "mcp") {
        pluginCard.files.push({
          configObjectId: object.id,
          objectType: object.objectType,
          title: object.title,
          path: `openwork-connect://${marketplace.id}/${resolved.plugin.id}/${object.id}`,
          versionId: object.latestVersion?.id ?? null,
          updatedAt: object.updatedAt,
        });
        for (const item of toMcpEntries(marketplace, resolved.plugin, object)) {
          mcpServers.push(item.entry);
          mcpStatuses[item.entry.id ?? item.entry.name] = item.status;
        }
      }
    }
    if (!pluginsById.has(resolved.plugin.id)) pluginsById.set(resolved.plugin.id, pluginCard);
  }

  const pluginCards = [...pluginsById.values()]
    .filter((plugin) => plugin.files.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
  skills.sort((left, right) => left.name.localeCompare(right.name));
  mcpServers.sort((left, right) => left.name.localeCompare(right.name));
  return { skills, plugins: pluginCards, mcpServers, mcpStatuses };
}
