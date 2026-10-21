import type { DenExternalMcpConnection } from "@/app/lib/den";
import type { McpServerEntry, McpStatus, McpStatusMap } from "@/app/types";
import type { PlusMenuConnector } from "./composer-plus-menu-model";
import { canMemberAuthorizeConnection, connectionNeedsReconnect } from "@/react-app/domains/connections/native-provider-connections";
import {
  isOrgMcpConnectionReady,
  nativeProviderDisplayName,
  orgConnectionCanRender,
} from "@/react-app/domains/settings/extension-items";

export type ComposerConnectionSignIn = {
  connectionId: string;
  reconnect: boolean;
};

export function orgMcpConnectionStatus(connection: DenExternalMcpConnection): McpStatus {
  if (isOrgMcpConnectionReady(connection)) return { status: "connected" };
  if (connectionNeedsReconnect(connection)) return { status: "reconnect_required" };
  if (connection.credentialMode === "shared") {
    return { status: "failed", error: "Organization setup is required." };
  }
  return { status: "needs_auth" };
}

export function orgMcpConnectionToComposerEntry(connection: DenExternalMcpConnection): McpServerEntry {
  const provider = nativeProviderDisplayName(connection.nativeProviderKey);
  return {
    id: `org-mcp:${connection.id}`,
    name: connection.name,
    config: { type: "remote", url: connection.url },
    origin: "openwork-connect",
    marketplaceName: provider ?? "OpenWork Cloud",
    orgMcpConnectionId: connection.id,
  };
}

export function mergeComposerConnectionInventory(input: {
  mcpServers: McpServerEntry[];
  mcpStatuses?: McpStatusMap;
  orgConnections: DenExternalMcpConnection[];
}): { servers: McpServerEntry[]; statuses: McpStatusMap } {
  const statuses: McpStatusMap = { ...(input.mcpStatuses ?? {}) };
  const listedConnectionIds = new Set<string>();
  const orgServers: McpServerEntry[] = [];

  for (const connection of input.orgConnections) {
    if (!orgConnectionCanRender(connection)) continue;
    const entry = orgMcpConnectionToComposerEntry(connection);
    orgServers.push(entry);
    listedConnectionIds.add(connection.id);
    const statusKey = entry.id ?? connection.id;
    statuses[statusKey] = orgMcpConnectionStatus(connection);
    statuses[connection.id] = statuses[statusKey];
  }

  const extraServers = input.mcpServers.filter((server) => {
    const connectionId = server.orgMcpConnectionId?.trim();
    if (connectionId && listedConnectionIds.has(connectionId)) return false;
    return true;
  });

  return {
    servers: [...orgServers, ...extraServers],
    statuses,
  };
}

export function composerConnectionSignIn(input: {
  server: McpServerEntry;
  status: McpStatus | undefined;
  connection?: DenExternalMcpConnection;
}): ComposerConnectionSignIn | null {
  const connectionId = input.connection?.id ?? input.server.orgMcpConnectionId?.trim();
  if (!connectionId) return null;
  if (input.connection && !canMemberAuthorizeConnection(input.connection)) return null;
  if (input.status?.status === "needs_auth") {
    return { connectionId, reconnect: false };
  }
  if (input.status?.status === "reconnect_required") {
    return { connectionId, reconnect: true };
  }
  return null;
}

/** The runtime status of a listed MCP server, looked up by id first and then by name. */
export function mcpEntryStatus(entry: McpServerEntry, statuses: McpStatusMap | undefined): McpStatus | undefined {
  if (!statuses) return undefined;
  if (entry.id && statuses[entry.id]) return statuses[entry.id];
  return statuses[entry.name];
}

/** A connector row of the composer: what the plus menu lists and what the connectors indicator counts. */
export type ComposerConnectorEntry = PlusMenuConnector & {
  /** The engine reports the server as connected. A server without a known status is not. */
  connected: boolean;
};

export function composerConnectorEntries(input: {
  servers: readonly McpServerEntry[];
  statuses: McpStatusMap | undefined;
  orgConnections: readonly DenExternalMcpConnection[];
  connectingId: string | null;
  /** Short reason shown instead of a sign-in action when the connector cannot be used as is. */
  noteFor: (status: McpStatus | undefined) => string | null;
}): ComposerConnectorEntry[] {
  return input.servers.map((server) => {
    const status = mcpEntryStatus(server, input.statuses);
    const connection = input.orgConnections.find((entry) => entry.id === server.orgMcpConnectionId);
    const signIn = composerConnectionSignIn({ server, status, connection });
    return {
      key: server.id ?? server.name,
      name: server.name,
      serviceUrl: server.config.type === "remote" ? server.config.url : undefined,
      signIn,
      connecting: Boolean(signIn && input.connectingId === signIn.connectionId),
      note: signIn ? null : input.noteFor(status),
      connected: status?.status === "connected",
    };
  });
}

/** Connected connectors first, each group in its original order. */
export function connectedFirst<T extends { connected: boolean }>(entries: readonly T[]): T[] {
  return [...entries.filter((entry) => entry.connected), ...entries.filter((entry) => !entry.connected)];
}
