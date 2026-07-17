import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";

export function marketplaceConnectionNeedsAdminSetup(
  connection: ExternalMcpConnection,
  _presets: ExternalMcpPreset[],
): boolean {
  return connection.identityManagedBy.length > 0 && connection.setupRequired === true;
}
