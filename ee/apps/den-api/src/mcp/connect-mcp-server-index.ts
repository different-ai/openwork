import type { McpServer } from "@modelcontextprotocol/server"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"

export const CONNECT_MCP_SERVER_INDEX_URI = "openwork://connect/mcp-servers/index.json"
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "openwork.connect/mcp-servers/1"
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-openwork-mcp-client-capabilities"
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1"

export function supportsConnectMcpAppHost(value: string | undefined): boolean {
  return value
    ?.split(",")
    .map((capability) => capability.trim())
    .includes(CONNECT_MCP_APP_HOST_CAPABILITY) ?? false
}

export type ConnectMcpServerIndexEntry = {
  connectionId: string
  name: string
  description: string | null
  url: string
  /** True when an administrator opted this connection into direct exposure as a standard MCP server. */
  exposeDirectly: boolean
}

/**
 * Which member-usable connections an index reader may see. The App host sees
 * every ready connection; an ordinary client sees only the ones an
 * administrator exposed directly, because those are the only per-connection
 * URLs that serve it a provider catalog, and none at all while the
 * organization has member-facing MCP connections disabled.
 */
export function selectConnectMcpServerIndexConnections(input: {
  appHostClient: boolean
  memberFacingMcpConnectionsEnabled: boolean
  connections: ExternalMcpConnectionRow[]
}): ExternalMcpConnectionRow[] {
  if (input.appHostClient) return input.connections
  if (!input.memberFacingMcpConnectionsEnabled) return []
  return input.connections.filter((connection) => connection.exposeDirectly)
}

export function buildConnectMcpServerIndex(input: {
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  publicOrigin: string
}) {
  return {
    schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
    servers: (input.enabled ? input.connections : [])
      .map((connection): ConnectMcpServerIndexEntry => ({
        connectionId: connection.id,
        name: connection.name,
        description: null,
        url: `${input.publicOrigin}/mcp/agent/connections/${encodeURIComponent(connection.id)}`,
        exposeDirectly: connection.exposeDirectly,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.connectionId.localeCompare(right.connectionId)),
  }
}

export function registerConnectMcpServerIndex(input: {
  server: McpServer
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  publicOrigin: string
}) {
  input.server.registerResource("openwork-connect-mcp-servers", CONNECT_MCP_SERVER_INDEX_URI, {
    title: "OpenWork Connect MCP servers",
    description: "Member-authorized MCP servers available through OpenWork Connect.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: CONNECT_MCP_SERVER_INDEX_URI,
      mimeType: "application/json",
      text: JSON.stringify(buildConnectMcpServerIndex(input)),
    }],
  }))
}
