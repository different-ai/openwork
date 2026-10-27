import type { Tool, ToolAnnotations } from "@modelcontextprotocol/server"
import type { ExternalMcpToolPolicy } from "@openwork-ee/den-db"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"

/**
 * Standard MCP tools for one connection's own MCP server (connection-server.ts).
 * The server is the namespace, so each tool keeps its provider's name, and each
 * runs as the Connect capability execute_capability takes for it.
 */

/** Under the agent OAuth resource, so its metadata and tokens apply as they do on /mcp/agent. */
export const CONNECTION_SERVER_ROUTE = "/mcp/agent/servers/:connectionId"

/** The URL of a connection's server, beneath the advertised agent resource. */
export function connectionServerUrl(agentResource: string, connectionId: string): string {
  return `${agentResource.replace(/\/+$/, "")}/servers/${encodeURIComponent(connectionId)}`
}

/** A tool a connection's server lists, and the capability that runs it. */
export type ConnectionServerTool = {
  tool: Tool
  /** The exact name execute_capability takes. */
  capability: string
  /** `arguments`: the provider's own arguments object. `api`: a native operation's { path, query, body }. */
  call: "arguments" | "api"
}

/** The one tool a connection's server lists until the member can use it. */
export const CONNECTION_STATUS_TOOL_NAME = "connection_status"

export type ProviderToolListing = {
  name: string
  title?: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: unknown
  _meta?: unknown
}

export type NativeOperationListing = {
  name: string
  method: string
  summary?: string
  description?: string
  inputSchema: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** MCP tool and output schemas must describe objects; anything else would fail the whole list. */
function objectSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "object")) return undefined
  return { ...value, type: "object" }
}

/** Tools a provider shows only to its App (UI visibility without "model") stay off the model's list. */
function visibleToModel(tool: ProviderToolListing): boolean {
  const ui = isRecord(tool._meta) && isRecord(tool._meta.ui) ? tool._meta.ui : {}
  return ui.visibility === undefined || (Array.isArray(ui.visibility) && ui.visibility.includes("model"))
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Name order, first of each name kept: the same listing always gives the same tools. */
function inNameOrder(tools: ConnectionServerTool[]): ConnectionServerTool[] {
  const byName = new Map<string, ConnectionServerTool>()
  for (const tool of [...tools].sort((left, right) => compare(left.tool.name, right.tool.name))) {
    if (!byName.has(tool.tool.name)) byName.set(tool.tool.name, tool)
  }
  return [...byName.values()]
}

/** An external connection's provider tools, minus those its tool policy disables. */
export function providerConnectionServerTools(input: {
  toolPolicy: ExternalMcpToolPolicy | null
  tools: readonly ProviderToolListing[]
  capabilityName: (toolName: string) => string
}): ConnectionServerTool[] {
  if (input.toolPolicy?.allDisabled) return []
  return inNameOrder(input.tools.flatMap((listed) => {
    const inputSchema = objectSchema(listed.inputSchema)
    if (!inputSchema || isToolDisabled(input.toolPolicy, listed.name) || !visibleToModel(listed)) return []
    const outputSchema = objectSchema(listed.outputSchema)
    const description = listed.description ?? listed.title ?? listed.name
    return [{
      tool: {
        name: listed.name,
        ...(listed.title ? { title: listed.title } : {}),
        description,
        inputSchema: inputSchema as Tool["inputSchema"],
        ...(outputSchema ? { outputSchema: outputSchema as Tool["outputSchema"] } : {}),
        // Passed through as the provider sent them, as they describe the tool to clients.
        ...(isRecord(listed.annotations) ? { annotations: listed.annotations as ToolAnnotations } : {}),
      },
      capability: input.capabilityName(listed.name),
      call: "arguments" as const,
    }]
  }))
}

/**
 * A native provider's operations. Their results are text, not structured
 * content, so no output schema is advertised for clients to enforce.
 */
export function nativeConnectionServerTools(input: {
  operations: readonly NativeOperationListing[]
  capabilityName: (operationName: string) => string
}): ConnectionServerTool[] {
  return inNameOrder(input.operations.flatMap((operation) => {
    const inputSchema = objectSchema(operation.inputSchema)
    if (!inputSchema) return []
    return [{
      tool: {
        name: operation.name,
        ...(operation.summary ? { title: operation.summary } : {}),
        description: operation.description ?? operation.summary ?? operation.name,
        inputSchema: inputSchema as Tool["inputSchema"],
        annotations: { readOnlyHint: operation.method === "GET", openWorldHint: true },
      },
      capability: input.capabilityName(operation.name),
      call: "api" as const,
    }]
  }))
}

export function connectionStatusTool(connectionName: string): Tool {
  return {
    name: CONNECTION_STATUS_TOOL_NAME,
    title: `Connect ${connectionName}`,
    description: `${connectionName} is not ready for you yet. Call this to show how to connect it; its tools are listed here once it is connected.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }
}

/** The capability input a listed tool's arguments become. */
export function connectionServerCall(tool: ConnectionServerTool, args: Record<string, unknown>) {
  if (tool.call === "arguments") return { name: tool.capability, body: args }
  return { name: tool.capability, path: args.path, query: args.query, body: args.body }
}
