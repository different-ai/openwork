import { isNativeProviderConnectionId, type ExternalMcpConnection } from "./mcp-connections-data";
import { connectionNeedsOAuthClientConfiguration } from "./mcp-connection-setup";

/** Native clients have usable entries even when they have no managed MCP row. */
export function displayedConnectorConnections(
  manageable: readonly ExternalMcpConnection[],
  usable: readonly ExternalMcpConnection[],
): ExternalMcpConnection[] {
  return [
    ...usable.filter((connection) => isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)
      && !manageable.some((entry) => entry.id === connection.id)),
    ...manageable,
  ];
}

export function connectorAccountReady(connection: ExternalMcpConnection): boolean {
  return !connection.setupRequired
    && !connectionNeedsOAuthClientConfiguration(connection)
    && !connection.issuerReviewRequired
    && !connection.needsReconnect
    && connection.credentialHealth !== "reconnect_required"
    && (connection.credentialMode === "per_member" ? connection.connectedForMe : connection.connected);
}
