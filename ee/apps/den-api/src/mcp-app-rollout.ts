import { getOrganizationFeatures, type FeatureMap } from "./features.js"

/**
 * Whether members of this organization can build their own Apps, each served
 * as its own MCP server: the appMcpServers feature (on by default) and the
 * organization's member-facing MCP connections are both on.
 *
 * It gates only Apps built in OpenWork. MCP Apps from connected MCP servers
 * work either way, and where it is off, Workflow-bound views stay writable.
 */
export function appMcpServersEnabled(features: Pick<FeatureMap, "appMcpServers" | "mcpConnections">): boolean {
  return features.appMcpServers && features.mcpConnections
}

/** The same check by organization id, for callers that do not hold its features. */
export async function organizationBuildsMcpApps(organizationId: string): Promise<boolean> {
  return appMcpServersEnabled(await getOrganizationFeatures(organizationId))
}
