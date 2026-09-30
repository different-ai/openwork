import type { McpServer } from "@modelcontextprotocol/server"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import type { McpAppEntry } from "../mcp-apps.js"

export const CONNECT_MCP_SERVER_INDEX_URI = "openwork://connect/mcp-servers/index.json"
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "openwork.connect/mcp-servers/1"
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-openwork-mcp-client-capabilities"
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1"
/** Released desktops reject an index with more servers outright, so Apps never push it past this. */
export const CONNECT_MCP_SERVER_INDEX_MAX_SERVERS = 100
const INDEX_DESCRIPTION_MAX_CHARS = 1_024

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

const byName = (left: ConnectMcpServerIndexEntry, right: ConnectMcpServerIndexEntry) =>
  left.name.localeCompare(right.name) || left.connectionId.localeCompare(right.connectionId)

/**
 * How many Apps fit beside this many connections. Apps only fill the room
 * connections leave, so they never change which connections a desktop sees,
 * and OpenWork can only open an App that is listed.
 */
export function connectMcpServerIndexAppCapacity(connectionCount: number): number {
  return Math.max(0, CONNECT_MCP_SERVER_INDEX_MAX_SERVERS - connectionCount)
}

/**
 * Connections, then, for the App host, the member's authored Apps in title
 * order while they fit. Each App is its own MCP server at a connection path,
 * listed so the host can open it but never exposed to the model directly: its
 * tools are for the App itself. Without apps, the index is exactly the
 * connection index it has always been.
 */
export function buildConnectMcpServerIndex(input: {
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  apps?: McpAppEntry[]
  publicOrigin: string
}) {
  const connections = (input.enabled ? input.connections : [])
    .map((connection): ConnectMcpServerIndexEntry => ({
      connectionId: connection.id,
      name: connection.name,
      description: null,
      url: `${input.publicOrigin}/mcp/agent/connections/${encodeURIComponent(connection.id)}`,
      exposeDirectly: connection.exposeDirectly,
    }))
    .sort(byName)
  const apps = (input.enabled ? input.apps ?? [] : [])
    .map((app): ConnectMcpServerIndexEntry => ({
      connectionId: app.appId,
      name: app.title,
      description: app.description ? app.description.slice(0, INDEX_DESCRIPTION_MAX_CHARS) : null,
      url: `${input.publicOrigin}${app.serverPath}`,
      exposeDirectly: false,
    }))
    .sort(byName)
    .slice(0, connectMcpServerIndexAppCapacity(connections.length))
  return {
    schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
    servers: apps.length === 0 ? connections : [...connections, ...apps].sort(byName),
  }
}

export function registerConnectMcpServerIndex(input: {
  server: McpServer
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  apps?: McpAppEntry[]
  publicOrigin: string
}) {
  input.server.registerResource("openwork-connect-mcp-servers", CONNECT_MCP_SERVER_INDEX_URI, {
    title: "OpenWork Connect MCP servers",
    description: input.apps === undefined
      ? "Member-authorized MCP servers available through OpenWork Connect."
      : "Member-authorized MCP servers available through OpenWork Connect, including each App the member can use.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: CONNECT_MCP_SERVER_INDEX_URI,
      mimeType: "application/json",
      text: JSON.stringify(buildConnectMcpServerIndex(input)),
    }],
  }))
}
