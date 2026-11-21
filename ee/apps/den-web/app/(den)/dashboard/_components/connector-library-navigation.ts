import type { ExternalMcpConnection } from "./mcp-connections-data";

export function assignedConnectorForLibrary(
  connectionId: string,
  usable: readonly ExternalMcpConnection[] | undefined,
): ExternalMcpConnection | undefined {
  return usable?.find((connection) => connection.id === connectionId);
}

export function personalConnectorDisconnectLabel(connection: ExternalMcpConnection | undefined): "Remove your key" | "Sign out of your account" | null {
  if (!connection || connection.credentialMode !== "per_member" || !connection.connectedForMe || connection.authType === "none") return null;
  return connection.authType === "apikey" ? "Remove your key" : "Sign out of your account";
}

export function canOpenConnectorManagement(access: { canViewAllConnections: boolean } | null): boolean {
  return access?.canViewAllConnections === true;
}
