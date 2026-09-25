import { z } from "zod"

export const MCP_APP_CONFIG_SCHEMA_VERSION = "openwork.mcp-app/1"
export const MCP_APP_PAYLOAD_KIND = "authored_mcp_app"
export const MCP_APP_MAX_STORAGE_BYTES = 1024 * 1024
export const MCP_APP_MAX_HTML_BYTES = 768 * 1024

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

export const mcpAppAuthoringSchema = mcpAppSourceSchema.extend({
  title: titleSchema,
  description: descriptionSchema.optional(),
  cssSource: mcpAppSourceSchema.shape.cssSource.optional(),
  textFallback: textFallbackSchema,
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
  html: z.string().min(1).max(MCP_APP_MAX_HTML_BYTES).refine((value) => byteLength(value) <= MCP_APP_MAX_HTML_BYTES),
  htmlBytes: z.number().int().positive().max(MCP_APP_MAX_HTML_BYTES),
  resourceDigest: digestSchema,
  sourceDigest: digestSchema,
  csp: mcpAppCspSchema,
  compilerName: z.literal("openwork-react-mcp-app"),
  compilerVersion: z.string().min(1).max(64),
  reactVersion: z.string().min(1).max(64),
}).strict().refine((value) => byteLength(JSON.stringify(value)) <= MCP_APP_MAX_STORAGE_BYTES)

export const mcpAppSummarySchema = z.object({
  appId: mcpAppIdSchema,
  pluginId: pluginIdSchema,
  revisionId: mcpAppRevisionIdSchema,
  title: titleSchema,
  description: descriptionSchema.nullable(),
  textFallback: textFallbackSchema,
  toolName: z.string(),
  resourceUri: z.string(),
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
export type McpAppCompiledRevision = z.infer<typeof mcpAppCompiledRevisionSchema>
export type McpAppSource = z.infer<typeof mcpAppSourceSchema>
export type McpAppCsp = z.infer<typeof mcpAppCspSchema>
export type CreateMcpAppInput = z.infer<typeof createMcpAppInputSchema>
export type UpdateMcpAppInput = z.infer<typeof updateMcpAppInputSchema>
export type ReadMcpAppInput = z.infer<typeof readMcpAppInputSchema>
export type ReadMcpAppOutput = z.infer<typeof readMcpAppOutputSchema>

export function mcpAppToolName(appId: string): string {
  return `open_app_${mcpAppIdSchema.parse(appId)}`
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
    toolName: mcpAppToolName(input.appId),
    resourceUri: mcpAppResourceUri(input.appId, input.revisionId),
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
