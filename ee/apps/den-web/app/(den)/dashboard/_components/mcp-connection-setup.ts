import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";

export function marketplaceConnectionNeedsAdminSetup(
  connection: ExternalMcpConnection,
  _presets: ExternalMcpPreset[],
): boolean {
  return connection.identityManagedBy.length > 0 && connection.setupRequired === true;
}

export function marketplaceConnectionSetupTarget(
  connection: ExternalMcpConnection,
  presets: ExternalMcpPreset[],
  isAdmin: boolean,
): { connectionId: string; pluginId: string } | null {
  if (!isAdmin || !marketplaceConnectionNeedsAdminSetup(connection, presets)) return null;
  const pluginId = connection.identityManagedBy[0]?.pluginId;
  return pluginId ? { connectionId: connection.id, pluginId } : null;
}
