import type { createDenClient, DenExternalMcpConnection } from "@/app/lib/den";
import type { ActivityResource, ActivityScope, ActivitySource } from "@/react-app/kernel/activity-types";
import { libraryPluginFileFallbackDetailId } from "@/react-app/domains/settings/library";
import { skillSlashCommandName } from "@/react-app/domains/session/surface/composer/slash-command";
import {
  listAssignedConnectCapabilities,
  type ConnectCapabilityClient,
  type ConnectCapabilityInventory,
} from "@/react-app/domains/session/surface/connect-capability-inventory";

export type MemberActivityClient = ConnectCapabilityClient & Pick<ReturnType<typeof createDenClient>,
  "listOrgLlmProviders" | "listOrgGatewayProviders" | "listMcpConnections"
>;

type ActivityFeed = {
  observe: (input: { scope: ActivityScope; source: ActivitySource; resources: ActivityResource[]; observedAt: number }) => void;
  setRefreshState: (scope: ActivityScope, state: "idle" | "refreshing" | "error") => void;
};

function extensionHref(detailId: string) {
  return `/extensions/${encodeURIComponent(detailId)}`;
}

/** Persist a digest, not URLs which can contain credentials or private configuration. */
async function connectionRevision(connection: DenExternalMcpConnection, versions: string[]) {
  const content = JSON.stringify([
    connection.name, connection.url, connection.authType,
    connection.credentialMode, connection.exposeDirectly, [...versions].sort(),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function connectionResources(inventory: ConnectCapabilityInventory, connections: DenExternalMcpConnection[]) {
  const revisions = new Map<string, Set<string>>();
  for (const plugin of inventory.plugins) {
    for (const file of plugin.files) {
      if (file.objectType !== "mcp") continue;
      const capability = `plugin:${plugin.pluginId}:${file.configObjectId}`;
      const servers = inventory.mcpServers.filter((server) => server.connectCapabilityName === capability);
      for (const server of servers) {
        if (!server.orgMcpConnectionId || !file.versionId) continue;
        const versions = revisions.get(server.orgMcpConnectionId) ?? new Set<string>();
        versions.add(file.versionId);
        revisions.set(server.orgMcpConnectionId, versions);
      }
    }
  }
  // The usable connection keeps its identity whether it was granted directly,
  // through a plugin, or both. An unbound plugin config is not a connection yet;
  // the plugin's own availability still appears in Activity.
  return Promise.all(connections
    .map(async (connection): Promise<ActivityResource> => ({
      id: connection.id,
      kind: "connection",
      label: connection.name,
      revision: await connectionRevision(connection, [...(revisions.get(connection.id) ?? [])]),
      href: extensionHref(`org-mcp:${connection.id}`),
      ...(connection.nativeProviderKey ? { serviceId: connection.nativeProviderKey } : {}),
    })));
}

function capabilityResources(inventory: ConnectCapabilityInventory): ActivityResource[] {
  const skillCards = new Map(inventory.skills.flatMap((skill) =>
    skill.connectCapabilityName ? [[skill.connectCapabilityName, skill] as const] : []));
  return inventory.plugins.flatMap((plugin): ActivityResource[] => {
    const skills = plugin.files.filter((file) => file.objectType === "skill");
    // Items shared into the member's own Library have no marketplace to name.
    const marketplaceName = plugin.marketplaceId === "me-library" ? undefined : plugin.marketplaceName.trim() || undefined;
    return [
      {
        id: plugin.pluginId,
        kind: "plugin",
        label: plugin.name,
        revision: null,
        href: plugin.files.length > 0 ? extensionHref(`plugin:${plugin.pluginId}`) : "/extensions",
        skillCount: skills.length,
        ...(marketplaceName ? { marketplaceName } : {}),
      },
      ...skills.map((file): ActivityResource => {
        const card = file.connectCapabilityName ? skillCards.get(file.connectCapabilityName) : undefined;
        return {
          id: file.configObjectId,
          kind: "skill",
          label: file.title,
          pluginName: plugin.name,
          revision: file.versionId,
          href: extensionHref(libraryPluginFileFallbackDetailId(plugin.pluginId, file)),
          ...(marketplaceName ? { marketplaceName } : {}),
          ...(card && file.connectCapabilityName
            ? { skillSlug: skillSlashCommandName(card), capability: file.connectCapabilityName }
            : {}),
        };
      }),
    ];
  });
}

/**
 * The public sync -> feed boundary. Only a complete, current successful pass
 * advances the baselines. Credential health, local installation drift and
 * engine connectivity are deliberately not used as access evidence.
 */
export async function refreshMemberActivity(input: {
  scope: ActivityScope;
  client: MemberActivityClient;
  feed: ActivityFeed;
  isCurrent: () => boolean;
}): Promise<"updated" | "failed" | "stale"> {
  if (!input.isCurrent()) return "stale";
  input.feed.setRefreshState(input.scope, "refreshing");
  try {
    const [legacyProviders, gatewayProviders, inventory, connections] = await Promise.all([
      input.client.listOrgLlmProviders(input.scope.organizationId),
      input.client.listOrgGatewayProviders(input.scope.organizationId),
      listAssignedConnectCapabilities({
        client: input.client,
        organizationId: input.scope.organizationId,
        requireComplete: true,
      }),
      input.client.listMcpConnections(input.scope.organizationId, "usable"),
    ]);
    const connectionSnapshot = await connectionResources(inventory, connections);
    if (!input.isCurrent()) return "stale";
    const observedAt = Date.now();
    const providers = [...legacyProviders, ...gatewayProviders].map((provider): ActivityResource => ({
      id: provider.id,
      kind: "provider",
      label: provider.name,
      revision: null,
      href: "/settings/cloud-providers",
      serviceId: provider.providerId,
    }));
    input.feed.observe({ scope: input.scope, source: "providers", resources: providers, observedAt });
    input.feed.observe({ scope: input.scope, source: "capabilities", resources: capabilityResources(inventory), observedAt });
    input.feed.observe({ scope: input.scope, source: "connections", resources: connectionSnapshot, observedAt });
    input.feed.setRefreshState(input.scope, "idle");
    return "updated";
  } catch (error) {
    if (!input.isCurrent()) return "stale";
    // Keep the reason findable; the UI only says "Couldn't refresh".
    console.warn("[activity] member inventory refresh failed", error instanceof Error ? `${error.name}: ${error.message}` : error);
    input.feed.setRefreshState(input.scope, "error");
    return "failed";
  }
}
