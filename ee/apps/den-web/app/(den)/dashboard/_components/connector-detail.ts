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
  return !connection.policyBlocked && !connection.setupRequired
    && !connectionNeedsOAuthClientConfiguration(connection)
    && !connection.issuerReviewRequired
    && !connection.needsReconnect
    && connection.credentialHealth !== "reconnect_required"
    && (connection.credentialMode === "per_member" ? connection.connectedForMe : connection.connected);
}

/** Slack's stored account identity is encoded workspace/user data, not an email. */
export function connectorAccountLabel(connection: ExternalMcpConnection): string | null {
  if (connection.nativeProviderKey === "slack") return connection.connectedForMe ? "Your Slack account" : null;
  return connection.externalAccountId ?? null;
}

export function connectorLimitedAccess(connection: ExternalMcpConnection): string | null {
  if (connection.nativeProviderKey !== "slack" || !connectorAccountReady(connection)) return null;
  const labels: Record<string, string> = {
    privateChannels: "private channels",
    directMessages: "direct messages",
    groupMessages: "group direct messages",
  };
  const missing = (connection.missingFeatures ?? []).flatMap((feature) => labels[feature] ? [labels[feature]] : []);
  return missing.length > 0 ? `Limited permissions for: ${missing.join(", ")}` : null;
}
