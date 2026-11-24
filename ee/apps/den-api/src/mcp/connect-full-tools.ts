import { createHash } from "node:crypto"
import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server"
import type { ExternalMcpToolPolicy } from "@openwork-ee/den-db"
import { z } from "zod"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import type { ExecuteCapabilityToolResult } from "./capability-registry.js"
import { toolTitle, withSafetyHints } from "./tool-labels.js"

export const CONNECT_FULL_TOOL_NAME_MAX_LENGTH = 64
export const CONNECTION_STATUS_TOOL_NAME = "connection_status"
export const WORKFLOW_TOOL_NAMESPACE = "run-workflow"
export const APP_TOOL_NAMESPACE = "open-app"
export const REMOTE_SESSION_TOOL_NAMESPACE = "remote-session"
export const OPENWORK_BOT_TOOL_NAMESPACE = "openwork-bot"

export type ConnectFullToolCandidate = {
  namespace: string
  toolName: string
  capability: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: ToolAnnotations
}

export type ConnectFullTool = ConnectFullToolCandidate & { name: string; title: string; annotations: ToolAnnotations }

export type CapabilityCall = { name: string; arguments?: unknown; path?: unknown; query?: unknown; body?: unknown }

export type PendingConnection = { namespace: string; name: string }

const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9_.-]/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function objectSchema(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "object")) return undefined
  return value
}

export function connectFullToolName(namespace: string, toolName: string): string {
  const wanted = `${namespace}.${toolName}`
  const safe = wanted.replace(DISALLOWED_NAME_CHARACTERS, "_")
  if (safe === wanted && wanted.length <= CONNECT_FULL_TOOL_NAME_MAX_LENGTH) return wanted
  const suffix = `-${createHash("sha256").update(wanted).digest("hex").slice(0, 8)}`
  return `${safe.slice(0, CONNECT_FULL_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`
}

export function buildConnectFullTools(candidates: readonly ConnectFullToolCandidate[]): ConnectFullTool[] {
  const named = candidates
    .flatMap((candidate) => objectSchema(candidate.inputSchema)
      ? [{
        ...candidate,
        name: connectFullToolName(candidate.namespace, candidate.toolName),
        title: candidate.title ?? toolTitle(candidate.toolName, candidate.description),
        annotations: withSafetyHints(candidate.annotations),
      }]
      : [])
    .sort((left, right) => compare(left.name, right.name) || compare(left.capability, right.capability))
  const byName = new Map<string, ConnectFullTool>()
  for (const tool of named) if (!byName.has(tool.name)) byName.set(tool.name, tool)
  return [...byName.values()]
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function titledToolNames(items: readonly { id: string; title: string }[]): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set<string>()
  for (const item of [...items].sort((left, right) => compare(left.id, right.id))) {
    const base = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "untitled"
    const name = taken.has(base) ? `${base}_${item.id.slice(-6).toLowerCase()}` : base
    taken.add(name)
    names.set(item.id, name)
  }
  return names
}

export type ExternalToolListing = {
  name: string
  title?: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: unknown
}

export function externalToolCandidates(input: {
  connection: { id: string; name: string; namespace: string; toolPolicy: ExternalMcpToolPolicy | null }
  tools: readonly ExternalToolListing[]
  capabilityName: (connectionId: string, toolName: string) => string
}): ConnectFullToolCandidate[] {
  const { connection } = input
  if (connection.toolPolicy?.allDisabled) return []
  return input.tools.flatMap((tool) => {
    const inputSchema = objectSchema(tool.inputSchema)
    if (!inputSchema || isToolDisabled(connection.toolPolicy, tool.name)) return []
    const outputSchema = objectSchema(tool.outputSchema)
    const title = tool.title ?? (isRecord(tool.annotations) && typeof tool.annotations.title === "string" ? tool.annotations.title : undefined)
    return [{
      namespace: connection.namespace,
      toolName: tool.name,
      capability: input.capabilityName(connection.id, tool.name),
      ...(title ? { title } : {}),
      description: `[${connection.name}] ${tool.description ?? title ?? tool.name}`,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
    }]
  })
}

function advertisedSchema(schema: Record<string, unknown>): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "openwork",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  }
}


export function registerConnectFullTools(input: {
  server: McpServer
  tools: readonly ConnectFullTool[]
  execute: (call: CapabilityCall) => Promise<ExecuteCapabilityToolResult>
}) {
  for (const tool of input.tools) {
    input.server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: advertisedSchema(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: advertisedSchema(tool.outputSchema) } : {}),
      annotations: tool.annotations,
    }, async (args: unknown) => input.execute({ name: tool.capability, arguments: args }))
  }
}

export function registerConnectionStatusTool(input: {
  server: McpServer
  pending: readonly PendingConnection[]
  show: (connection: PendingConnection) => Promise<ExecuteCapabilityToolResult>
}) {
  const pending = [...input.pending].sort((left, right) => compare(left.namespace, right.namespace))
  const namespaces = pending.map((connection) => connection.namespace)
  input.server.registerTool(CONNECTION_STATUS_TOOL_NAME, {
    title: "Connection status",
    description: [
      "Show the sign-in or setup card for one of your organization's services that is not ready for you yet.",
      pending.length > 0
        ? `Not ready: ${pending.map((connection) => `${connection.name} (${connection.namespace})`).join(", ")}.`
        : "Every service you may use is ready.",
      "Use only when the user asks to connect a service or a tool fails because its connection is not ready.",
    ].join(" "),
    annotations: withSafetyHints({ readOnlyHint: true, openWorldHint: true }),
    inputSchema: z.object({
      connection: (namespaces.length > 0 ? z.enum(namespaces as [string, ...string[]]) : z.string())
        .describe("The service, as named in parentheses in this tool's description."),
    }),
  }, async ({ connection }) => {
    const match = pending.find((entry) => entry.namespace === connection)
    if (match) return input.show(match)
    return {
      content: [{
        type: "text" as const,
        text: pending.length > 0
          ? `${connection} has no pending connection. Not ready: ${namespaces.join(", ")}.`
          : `${connection} has no pending connection; every service you may use is ready.`,
      }],
    }
  })
}
