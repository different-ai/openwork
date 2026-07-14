import type {
  ConnectCapabilityMatch,
  ConnectCapabilitySource,
  ConnectToolResult,
} from "./contracts.js"

const REMOTE_MCP_CAPABILITY_PREFIX = "mcp:"
const DEFAULT_CONNECTION_LIMIT = 16
const DEFAULT_CONCURRENCY = 4

export type RemoteMcpCapabilityConnection = {
  id: string
  name: string
  serverUrl: string
  status: "connected" | "needs_auth" | "error"
  statusMessage?: string
}

export type RemoteMcpCapabilityTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

export type RemoteMcpCapabilitySourceOptions = {
  id?: string
  listConnections: () => Promise<readonly RemoteMcpCapabilityConnection[]>
  listTools: (connection: RemoteMcpCapabilityConnection) => Promise<readonly RemoteMcpCapabilityTool[]>
  callTool: (input: {
    connection: RemoteMcpCapabilityConnection
    toolName: string
    arguments: Record<string, unknown>
  }) => Promise<ConnectToolResult>
  connectionLimit?: number
  concurrency?: number
}

export function buildRemoteMcpCapabilityName(connectionId: string, toolName: string): string {
  return `${REMOTE_MCP_CAPABILITY_PREFIX}${connectionId}:${toolName}`
}

export function parseRemoteMcpCapabilityName(name: string): { connectionId: string; toolName: string } | null {
  if (!name.startsWith(REMOTE_MCP_CAPABILITY_PREFIX)) return null
  const rest = name.slice(REMOTE_MCP_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex === rest.length - 1) return null
  return {
    connectionId: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 1),
  }
}

export function tokenizeCapabilityText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

export function scoreCapabilityText(input: {
  name: string
  summary?: string
  connectionName?: string
  query: string
}): number {
  const queryTokens = tokenizeCapabilityText(input.query)
  const nameTokens = tokenizeCapabilityText(input.name)
  const summaryTokens = tokenizeCapabilityText(input.summary ?? "")
  const connectionTokens = tokenizeCapabilityText(input.connectionName ?? "")
  let score = 0
  for (const queryToken of queryTokens) {
    if (nameTokens.includes(queryToken)) score += 5
    else if (nameTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token))) score += 3
    if (summaryTokens.includes(queryToken)) score += 2
    if (connectionTokens.includes(queryToken)) score += 2
  }
  return score
}

function recordBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

function statusMatch(connection: RemoteMcpCapabilityConnection, query: string): ConnectCapabilityMatch | null {
  const score = scoreCapabilityText({
    name: connection.name,
    summary: connection.statusMessage ?? "connection needs attention",
    connectionName: connection.name,
    query,
  })
  if (score <= 0) return null
  const state = connection.status === "needs_auth" ? "needs_connection" : "provider_error"
  return {
    name: buildRemoteMcpCapabilityName(connection.id, "*"),
    method: "MCP",
    path: connection.serverUrl,
    score,
    summary: connection.statusMessage ?? `${connection.name} needs attention`,
    pathParams: [],
    queryParams: [],
    hasBody: false,
    kind: "connection_status",
    status: connection.status === "needs_auth" ? "needs_connection" : "error",
    connectionStatus: {
      layer: "mcp_connection",
      connectionId: connection.id,
      connectionName: connection.name,
      authType: "oauth",
      credentialMode: "local",
      state,
      errorCode: connection.status === "needs_auth" ? "not_connected" : "provider_error",
      message: connection.statusMessage ?? `${connection.name} needs attention`,
      actor: "member",
      action: {
        type: connection.status === "needs_auth" ? "connect" : "inspect_connection",
        label: connection.status === "needs_auth" ? `Connect ${connection.name}` : `Inspect ${connection.name}`,
        surface: "openwork_your_connections",
        retry: "search_capabilities",
      },
    },
  }
}

function toolMatch(
  connection: RemoteMcpCapabilityConnection,
  tool: RemoteMcpCapabilityTool,
  query: string,
): ConnectCapabilityMatch | null {
  const summary = tool.description?.trim() || tool.title?.trim() || `${tool.name} from ${connection.name}`
  const score = scoreCapabilityText({
    name: tool.name,
    summary,
    connectionName: connection.name,
    query,
  })
  if (score <= 0) return null
  return {
    name: buildRemoteMcpCapabilityName(connection.id, tool.name),
    method: "MCP",
    path: connection.serverUrl,
    score,
    summary,
    pathParams: [],
    queryParams: [],
    hasBody: true,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value !== undefined) results[index] = await operation(value)
    }
  })
  await Promise.all(workers)
  return results
}

export function createRemoteMcpCapabilitySource(options: RemoteMcpCapabilitySourceOptions): ConnectCapabilitySource {
  const connectionLimit = Math.max(1, Math.min(DEFAULT_CONNECTION_LIMIT, options.connectionLimit ?? DEFAULT_CONNECTION_LIMIT))
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, options.concurrency ?? DEFAULT_CONCURRENCY))

  return {
    id: options.id ?? "remote-mcp",
    types: ["mcp"],
    async search({ query, limit }) {
      const allConnections = [...await options.listConnections()]
        .sort((left, right) => {
          const score = scoreCapabilityText({ name: right.name, query }) - scoreCapabilityText({ name: left.name, query })
          return score || left.name.localeCompare(right.name)
        })
      const connections = allConnections.slice(0, connectionLimit)
      const grouped = await mapWithConcurrency(connections, concurrency, async (connection) => {
        if (connection.status !== "connected") {
          const match = statusMatch(connection, query)
          return match ? [match] : []
        }
        try {
          const tools = await options.listTools(connection)
          return tools
            .map((tool) => toolMatch(connection, tool, query))
            .filter((match): match is ConnectCapabilityMatch => match !== null)
        } catch (error) {
          const match = statusMatch({
            ...connection,
            status: "error",
            statusMessage: error instanceof Error ? error.message : "The connection could not be inspected.",
          }, query)
          return match ? [match] : []
        }
      })
      return {
        matches: grouped.flat()
          .sort((left, right) => {
            const statusPriority = Number(right.kind === "connection_status") - Number(left.kind === "connection_status")
            return statusPriority || (right.score - left.score) || left.name.localeCompare(right.name)
          })
          .slice(0, limit),
        ...(allConnections.length > connectionLimit
          ? { hint: `Remote MCP search inspected at most ${connectionLimit} connections.` }
          : {}),
      }
    },
    async canExecute(name) {
      const parsed = parseRemoteMcpCapabilityName(name)
      if (!parsed || parsed.toolName === "*") return false
      const connections = await options.listConnections()
      return connections.some((connection) => connection.id === parsed.connectionId && connection.status === "connected")
    },
    async execute({ name, body }) {
      const parsed = parseRemoteMcpCapabilityName(name)
      if (!parsed || parsed.toolName === "*") {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "unknown_capability", name }) }],
        }
      }
      const connection = (await options.listConnections()).find((candidate) => (
        candidate.id === parsed.connectionId && candidate.status === "connected"
      ))
      if (!connection) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "connection_unavailable", connectionId: parsed.connectionId }) }],
        }
      }
      return options.callTool({
        connection,
        toolName: parsed.toolName,
        arguments: recordBody(body),
      })
    },
  }
}
