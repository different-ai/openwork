import type { ExternalMcpConnection } from "./mcp-connections-data";

/** Manage access is not a grant to use a connector. Only trust the usable list. */
export function assignedConnectorForLibrary(
  connectionId: string,
  usable: readonly ExternalMcpConnection[] | undefined,
): ExternalMcpConnection | undefined {
  return usable?.find((connection) => connection.id === connectionId);
}

/**
 * Beside "Sign everyone out", the personal action names its scope. The
 * management menu is the only place both appear, so only it uses these labels.
 */
export function personalConnectorDisconnectLabel(connection: ExternalMcpConnection | undefined): "Remove your key" | "Sign out of your account" | null {
  if (!connection || connection.credentialMode !== "per_member" || !connection.connectedForMe || connection.authType === "none") return null;
  return connection.authType === "apikey" ? "Remove your key" : "Sign out of your account";
}

/**
 * The way back from My Library to Manage. Members manage what they added from
 * My Library itself (Share, Remove); Manage › Connectors needs `connections.view`,
 * so only people who can open that page get the link.
 */
export function canOpenConnectorManagement(access: { canViewAllConnections: boolean } | null): boolean {
  return access?.canViewAllConnections === true;
}
