import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server"
import type { ExecuteCapabilityToolResult } from "./capability-registry.js"

export const REMOTE_SESSION_TOOL_NAMESPACE = "remote-session"

export type ConnectFullTool = {
  namespace: string
  toolName: string
  capability: string
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: ToolAnnotations
}

export type CapabilityCall = { name: string; arguments?: unknown; path?: unknown; query?: unknown; body?: unknown }

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
