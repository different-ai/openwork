import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { CONNECT_SEARCH_TYPES, type ConnectRuntime } from "./contracts.js"
import { capabilitySearchToolResult } from "./runtime.js"

export const SEARCH_CAPABILITIES_TOOL_NAME = "search_capabilities"
export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"

export const SEARCH_CAPABILITIES_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

export const EXECUTE_CAPABILITY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

const externalMcpDiagnosticOutputSchema = z.object({
  referenceId: z.string(),
  phase: z.string(),
  category: z.string(),
  code: z.string(),
  highestPassed: z.string(),
  retryable: z.boolean(),
  actionOwner: z.string(),
  operatorAction: z.string(),
  message: z.string(),
  httpStatus: z.number().int().optional(),
  operationPhase: z.string().optional(),
  outbound: z.object({ origin: z.string(), pathHash: z.string() }).optional(),
  providerRequestId: z.string().optional(),
  providerStatus: z.number().int().optional(),
  providerCode: z.string().optional(),
  payloadBytes: z.number().int().optional(),
  jsonRpcCode: z.number().int().optional(),
})

const connectionStatusOutputSchema = z.object({
  layer: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  authType: z.string(),
  credentialMode: z.string(),
  state: z.string(),
  errorCode: z.string(),
  message: z.string(),
  actor: z.string(),
  action: z.object({
    type: z.string(),
    label: z.string(),
    surface: z.string(),
    retry: z.literal("search_capabilities"),
    url: z.string().url().optional(),
  }),
  diagnostic: externalMcpDiagnosticOutputSchema.optional(),
})

const capabilityMatchOutputSchema = z.object({
  name: z.string(),
  method: z.string(),
  path: z.string(),
  score: z.number(),
  summary: z.string(),
  pathParams: z.array(z.string()),
  queryParams: z.array(z.string()),
  hasBody: z.boolean(),
  kind: z.string().optional(),
  status: z.string().optional(),
  hint: z.string().optional(),
  connectionStatus: connectionStatusOutputSchema.optional(),
}).passthrough()

export const SEARCH_CAPABILITIES_OUTPUT_SCHEMA = z.object({
  matches: z.array(capabilityMatchOutputSchema),
  hint: z.string().optional(),
})

const searchCapabilityTypeSchema = z.enum(CONNECT_SEARCH_TYPES)

export const DEFAULT_CONNECT_MCP_INSTRUCTIONS = [
  "This OpenWork Connect connection intentionally exposes exactly two tools: search_capabilities and execute_capability.",
  "Always call search_capabilities first with 2-4 keyword variants before concluding something is unavailable.",
  "Use execute_capability only with exact names returned by search_capabilities.",
].join("\n")

export type ConnectMcpCopy = {
  searchDescription?: string
  executeDescription?: string
}

export function createConnectMcpServer(options?: {
  name?: string
  version?: string
  instructions?: string
}): McpServer {
  return new McpServer({
    name: options?.name ?? "openwork-connect",
    version: options?.version ?? "1.0.0",
  }, {
    instructions: options?.instructions ?? DEFAULT_CONNECT_MCP_INSTRUCTIONS,
  })
}

export function registerConnectTools(
  server: McpServer,
  runtime: ConnectRuntime,
  copy: ConnectMcpCopy = {},
): void {
  server.registerTool(
    SEARCH_CAPABILITIES_TOOL_NAME,
    {
      title: "Search capabilities",
      description: copy.searchDescription ?? [
        "Search for a capability by keyword.",
        "This connection exposes only this tool and execute_capability, so always search first.",
        "Try 2-4 keyword variants before deciding a capability is unavailable.",
      ].join(" "),
      annotations: SEARCH_CAPABILITIES_ANNOTATIONS,
      inputSchema: z.object({
        query: z.string().min(1).describe("Keywords describing the capability you need."),
        limit: z.number().int().min(1).max(20).optional().describe("Max number of matches to return. Defaults to 5."),
        type: searchCapabilityTypeSchema.optional().describe("Optional capability source filter. Defaults to all."),
      }),
      outputSchema: SEARCH_CAPABILITIES_OUTPUT_SCHEMA,
    },
    async ({ query, limit, type }) => {
      const result = await runtime.search({ query, limit, type })
      return capabilitySearchToolResult(result.matches, result.hint)
    },
  )

  server.registerTool(
    EXECUTE_CAPABILITY_TOOL_NAME,
    {
      title: "Execute capability",
      description: copy.executeDescription ?? [
        "Call a capability found via search_capabilities by its exact name.",
        "Pass path, query, and body only as described by the search match.",
      ].join(" "),
      annotations: EXECUTE_CAPABILITY_ANNOTATIONS,
      inputSchema: z.object({
        name: z.string().min(1).describe("The exact capability name returned by search_capabilities."),
        path: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
        query: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
        body: z.unknown().optional(),
      }),
    },
    async ({ name, path, query, body }) => runtime.execute({ name, path, query, body }),
  )
}
