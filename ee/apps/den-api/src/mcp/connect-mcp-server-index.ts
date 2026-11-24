import type { McpServer } from "@modelcontextprotocol/server"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import type { McpAppEntry } from "../mcp-apps.js"

export const CONNECT_MCP_SERVER_INDEX_URI = "openwork://connect/mcp-servers/index.json"
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "openwork.connect/mcp-servers/1"
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-openwork-mcp-client-capabilities"
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1"
export const CONNECT_MCP_SERVER_INDEX_MAX_SERVERS = 100
const INDEX_DESCRIPTION_MAX_CHARS = 1_024

export const CONNECT_NATIVE_SKILLS_CAPABILITY = "native-skills-v1"

function hasClientCapability(value: string | undefined, capability: string): boolean {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .includes(capability) ?? false
}

export function supportsConnectMcpAppHost(value: string | undefined): boolean {
  return hasClientCapability(value, CONNECT_MCP_APP_HOST_CAPABILITY)
}

export function supportsConnectNativeSkills(value: string | undefined): boolean {
  return hasClientCapability(value, CONNECT_NATIVE_SKILLS_CAPABILITY)
}

export type ConnectMcpServerIndexEntry = {
  connectionId: string
  name: string
  description: string | null
  url: string
  exposeDirectly: boolean
}

export function selectConnectMcpServerIndexConnections(input: {
  appHostClient: boolean
  connections: ExternalMcpConnectionRow[]
}): ExternalMcpConnectionRow[] {
  if (input.appHostClient) return input.connections
  return input.connections.filter((connection) => connection.exposeDirectly)
}

const byName = (left: ConnectMcpServerIndexEntry, right: ConnectMcpServerIndexEntry) =>
  left.name.localeCompare(right.name) || left.connectionId.localeCompare(right.connectionId)

export function connectMcpServerIndexAppCapacity(connectionCount: number): number {
  return Math.max(0, CONNECT_MCP_SERVER_INDEX_MAX_SERVERS - connectionCount)
}

export function buildConnectMcpServerIndex(input: {
  connections: ExternalMcpConnectionRow[]
  apps?: McpAppEntry[]
  publicOrigin: string
}) {
  const connections = input.connections
    .map((connection): ConnectMcpServerIndexEntry => ({
      connectionId: connection.id,
      name: connection.name,
      description: null,
      url: `${input.publicOrigin}/mcp/agent/connections/${encodeURIComponent(connection.id)}`,
      exposeDirectly: connection.exposeDirectly,
    }))
    .sort(byName)
  const apps = (input.apps ?? [])
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
