import { z } from "zod"

export const MCP_APP_CONFIG_SCHEMA_VERSION = "openwork.mcp-app/1"
export const MCP_APP_PAYLOAD_KIND = "authored_mcp_app"
export const MCP_APP_MAX_STORAGE_BYTES = 1024 * 1024
export const MCP_APP_MAX_HTML_BYTES = 768 * 1024
/** Every App's own MCP server opens it with this one tool. */
export const MCP_APP_LAUNCH_TOOL_NAME = "open_app"
export const MCP_APP_MAX_TOOLS = 20
export const MCP_APP_MAX_TOOL_SCHEMA_BYTES = 32 * 1024

export const mcpAppIdSchema = z.string().length(30).regex(/^cob_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
export const mcpAppRevisionIdSchema = z.string().length(30).regex(/^cov_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
const pluginIdSchema = z.string().length(30).regex(/^plg_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const titleSchema = z.string().trim().min(1).max(120)
const descriptionSchema = z.string().trim().max(2_000)
const textFallbackSchema = z.string().trim().min(1).max(8_000)
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

export const mcpAppSourceSchema = z.object({
  reactSource: z.string().trim().min(1).max(200_000).refine((value) => byteLength(value) <= 200_000),
  cssSource: z.string().trim().max(100_000).refine((value) => byteLength(value) <= 100_000),
}).strict()

export const mcpAppToolNameSchema = z.string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u, "Use a lowercase snake_case tool name.")
  .refine((name) => name !== MCP_APP_LAUNCH_TOOL_NAME, `${MCP_APP_LAUNCH_TOOL_NAME} is reserved for opening the App.`)

/**
 * A tool the App's MCP server exposes under a clear name. It runs one exact
 * capability from search_capabilities as the person using the App. `live`
 * runs a saved Workflow read-only with server-supplied time inputs.
 */
export const mcpAppToolDeclarationSchema = z.object({
  name: mcpAppToolNameSchema,
  description: z.string().trim().min(1).max(1_000),
  capability: z.string().trim().min(1).max(512),
  mode: z.enum(["input", "live"]).optional(),
}).strict()

const toolDeclarationsSchema = z.array(mcpAppToolDeclarationSchema).max(MCP_APP_MAX_TOOLS)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, "Tool names must be unique.")

const jsonSchemaObject = z.record(z.string(), z.json())
  .refine((schema) => schema.type === "object", "Tool input schemas must describe an object.")
  .refine((schema) => byteLength(JSON.stringify(schema)) <= MCP_APP_MAX_TOOL_SCHEMA_BYTES, "Tool input schema is too large.")

/**
 * A declared tool resolved when the revision was published: how its arguments
 * reach the capability, the schema it advertises, and whether Den verified it
 * as read-only.
 */
export const mcpAppToolBindingSchema = z.object({
  name: mcpAppToolNameSchema,
  description: z.string().min(1).max(1_000),
  capability: z.string().min(1).max(512),
  kind: z.enum(["workflow", "mcp", "api"]),
  mode: z.enum(["input", "live"]),
  inputSchema: jsonSchemaObject,
  readOnly: z.boolean(),
  schemaDigest: digestSchema.optional(),
}).strict()

export const mcpAppAuthoringSchema = mcpAppSourceSchema.extend({
  title: titleSchema,
  description: descriptionSchema.optional(),
  cssSource: mcpAppSourceSchema.shape.cssSource.optional(),
  textFallback: textFallbackSchema,
  tools: toolDeclarationsSchema.optional(),
})

export const createMcpAppInputSchema = mcpAppAuthoringSchema.extend({ pluginId: pluginIdSchema.optional() })
export const updateMcpAppInputSchema = mcpAppAuthoringSchema.extend({
  appId: mcpAppIdSchema,
  expectedRevisionId: mcpAppRevisionIdSchema,
})
export const readMcpAppInputSchema = z.object({ appId: mcpAppIdSchema }).strict()

export const mcpAppCspSchema = z.object({
  connectDomains: z.array(z.string()).max(0),
  resourceDomains: z.array(z.string()).max(0),
  frameDomains: z.array(z.string()).max(0),
  baseUriDomains: z.array(z.string()).max(0),
}).strict()

export const mcpAppCompiledRevisionSchema = z.object({
  kind: z.literal(MCP_APP_PAYLOAD_KIND),
  schemaVersion: z.literal(1),
  pluginId: pluginIdSchema,
  title: titleSchema,
  description: descriptionSchema.nullable(),
  textFallback: textFallbackSchema,
  tools: z.array(mcpAppToolBindingSchema).max(MCP_APP_MAX_TOOLS),
  html: z.string().min(1).max(MCP_APP_MAX_HTML_BYTES).refine((value) => byteLength(value) <= MCP_APP_MAX_HTML_BYTES),
  htmlBytes: z.number().int().positive().max(MCP_APP_MAX_HTML_BYTES),
  resourceDigest: digestSchema,
  sourceDigest: digestSchema,
  csp: mcpAppCspSchema,
  compilerName: z.literal("openwork-react-mcp-app"),
  compilerVersion: z.string().min(1).max(64),
  reactVersion: z.string().min(1).max(64),
}).strict().refine((value) => byteLength(JSON.stringify(value)) <= MCP_APP_MAX_STORAGE_BYTES)

export const mcpAppToolSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  capability: z.string(),
  mode: z.enum(["input", "live"]),
  readOnly: z.boolean(),
}).strict()

export const mcpAppSummarySchema = z.object({
  appId: mcpAppIdSchema,
  pluginId: pluginIdSchema,
  revisionId: mcpAppRevisionIdSchema,
  title: titleSchema,
  description: descriptionSchema.nullable(),
  textFallback: textFallbackSchema,
  toolName: z.literal(MCP_APP_LAUNCH_TOOL_NAME),
  resourceUri: z.string(),
  /** Path of the App's own MCP server, relative to the Den API origin. */
  serverPath: z.string(),
  tools: z.array(mcpAppToolSummarySchema),
}).strict()

export const mcpAppProjectionSchema = mcpAppSummarySchema.extend({
  kind: z.literal(MCP_APP_PAYLOAD_KIND),
  schemaVersion: z.literal(1),
})

export const readMcpAppOutputSchema = z.object({
  app: mcpAppSummarySchema,
  reactSource: z.string(),
  cssSource: z.string(),
}).strict()

export type McpAppSummary = z.infer<typeof mcpAppSummarySchema>
export type McpAppToolDeclaration = z.infer<typeof mcpAppToolDeclarationSchema>
export type McpAppToolBinding = z.infer<typeof mcpAppToolBindingSchema>
export type McpAppCompiledRevision = z.infer<typeof mcpAppCompiledRevisionSchema>
export type McpAppSource = z.infer<typeof mcpAppSourceSchema>
export type McpAppCsp = z.infer<typeof mcpAppCspSchema>
export type CreateMcpAppInput = z.infer<typeof createMcpAppInputSchema>
export type UpdateMcpAppInput = z.infer<typeof updateMcpAppInputSchema>
export type ReadMcpAppInput = z.infer<typeof readMcpAppInputSchema>
export type ReadMcpAppOutput = z.infer<typeof readMcpAppOutputSchema>

/**
 * Each App is served as its own MCP server beside directly exposed Connect
 * connections, so released clients and OAuth resource matching treat it like
 * any other connection endpoint under /mcp/agent.
 */
export function mcpAppServerPath(appId: string): string {
  return `/mcp/agent/connections/${mcpAppIdSchema.parse(appId)}`
}

export function mcpAppResourceUri(appId: string, revisionId: string): string {
  return `ui://openwork/apps/${mcpAppIdSchema.parse(appId)}/revisions/${mcpAppRevisionIdSchema.parse(revisionId)}/index.html`
}

export function parseMcpAppResourceUri(uri: string): { appId: string; revisionId: string } | null {
  const match = /^ui:\/\/openwork\/apps\/([^/]+)\/revisions\/([^/]+)\/index\.html$/u.exec(uri)
  if (!match || match[0] !== uri) return null
  const appId = mcpAppIdSchema.safeParse(match[1])
  const revisionId = mcpAppRevisionIdSchema.safeParse(match[2])
  return appId.success && revisionId.success ? { appId: appId.data, revisionId: revisionId.data } : null
}

export function isAuthoredMcpAppVersion(value: {
  schemaVersion?: string | null
  normalizedPayloadJson?: Record<string, unknown> | null
}): boolean {
  return value.schemaVersion?.trim() === MCP_APP_CONFIG_SCHEMA_VERSION
    || value.normalizedPayloadJson?.kind === MCP_APP_PAYLOAD_KIND
}

export function summarizeMcpAppRevision(input: {
  appId: string
  revisionId: string
  pluginId?: string
  payload: McpAppCompiledRevision
}): McpAppSummary {
  return {
    appId: input.appId,
    pluginId: input.pluginId ?? input.payload.pluginId,
    revisionId: input.revisionId,
    title: input.payload.title,
    description: input.payload.description,
    textFallback: input.payload.textFallback,
    toolName: MCP_APP_LAUNCH_TOOL_NAME,
    resourceUri: mcpAppResourceUri(input.appId, input.revisionId),
    serverPath: mcpAppServerPath(input.appId),
    tools: input.payload.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      mode: tool.mode,
      readOnly: tool.readOnly,
    })),
  }
}

export function redactMcpAppRevision(input: {
  configObjectId: string
  id: string
  normalizedPayloadJson: unknown
}): Record<string, unknown> | null {
  const parsed = mcpAppCompiledRevisionSchema.safeParse(input.normalizedPayloadJson)
  if (!parsed.success) return null
  return {
    kind: MCP_APP_PAYLOAD_KIND,
    schemaVersion: 1,
    ...summarizeMcpAppRevision({ appId: input.configObjectId, revisionId: input.id, payload: parsed.data }),
  }
}
