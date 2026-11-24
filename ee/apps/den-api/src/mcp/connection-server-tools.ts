import type { Tool } from "@modelcontextprotocol/server"
import type { ExternalMcpToolPolicy } from "@openwork-ee/den-db"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { toolTitle, withSafetyHints } from "./tool-labels.js"

export const CONNECTION_SERVER_ROUTE = "/mcp/agent/servers/:connectionId"

export function connectionServerUrl(agentResource: string, connectionId: string): string {
  return `${agentResource.replace(/\/+$/, "")}/servers/${encodeURIComponent(connectionId)}`
}

export type ConnectionServerTool = {
  tool: Tool
  capability: string
  call: "arguments" | "api"
}

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

function objectSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "object")) return undefined
  return { ...value, type: "object" }
}

function visibleToModel(tool: ProviderToolListing): boolean {
  const ui = isRecord(tool._meta) && isRecord(tool._meta.ui) ? tool._meta.ui : {}
  return ui.visibility === undefined || (Array.isArray(ui.visibility) && ui.visibility.includes("model"))
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function inNameOrder(tools: ConnectionServerTool[]): ConnectionServerTool[] {
  const byName = new Map<string, ConnectionServerTool>()
  for (const tool of [...tools].sort((left, right) => compare(left.tool.name, right.tool.name))) {
    if (!byName.has(tool.tool.name)) byName.set(tool.tool.name, tool)
  }
  return [...byName.values()]
}

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
    const annotationTitle = isRecord(listed.annotations) && typeof listed.annotations.title === "string" ? listed.annotations.title : undefined
    return [{
      tool: {
        name: listed.name,
        title: listed.title ?? annotationTitle ?? toolTitle(listed.name, listed.description),
        description,
        inputSchema: inputSchema as Tool["inputSchema"],
        ...(outputSchema ? { outputSchema: outputSchema as Tool["outputSchema"] } : {}),
        annotations: withSafetyHints(listed.annotations),
      },
      capability: input.capabilityName(listed.name),
      call: "arguments" as const,
    }]
  }))
}

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
        title: operation.summary ?? toolTitle(operation.name),
        description: operation.description ?? operation.summary ?? operation.name,
        inputSchema: inputSchema as Tool["inputSchema"],
        annotations: withSafetyHints({ readOnlyHint: operation.method === "GET", openWorldHint: true }),
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

export function connectionServerCall(tool: ConnectionServerTool, args: Record<string, unknown>) {
  if (tool.call === "arguments") return { name: tool.capability, body: args }
  return { name: tool.capability, path: args.path, query: args.query, body: args.body }
}
