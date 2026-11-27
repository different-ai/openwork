import { z } from "zod"

export const MCP_APP_CONFIG_SCHEMA_VERSION = "openwork.mcp-app/1"
export const MCP_APP_PAYLOAD_KIND = "authored_mcp_app"
export const MCP_APP_MAX_STORAGE_BYTES = 2 * 1024 * 1024
export const MCP_APP_MAX_HTML_BYTES = 1536 * 1024
/** Every App's own MCP server opens it with this one tool. */
export const MCP_APP_LAUNCH_TOOL_NAME = "open_app"
/**
 * Launch result _meta key holding what the App's read-only tools that need no
 * input returned as it opened, each with the exact arguments it ran with.
 */
export const MCP_APP_INITIAL_RESULTS_META = "openwork/initialResults"
export const MCP_APP_MAX_TOOLS = 20
/**
 * The two tools an App that declares storage gets from OpenWork itself: one
 * reads its saved rows, the other adds, changes or removes one row.
 */
export const MCP_APP_STORAGE_READ_TOOL_NAME = "storage_read"
export const MCP_APP_STORAGE_WRITE_TOOL_NAME = "storage_write"
/** Launch result _meta key that says whether an App's saved data can be used right now. */
export const MCP_APP_STORAGE_META = "openwork/storage"
export const MCP_APP_STORAGE_MAX_COLLECTIONS = 8
export const MCP_APP_STORAGE_MAX_FIELDS = 24
export const MCP_APP_STORAGE_MAX_TEXT_LENGTH = 4_000
export const MCP_APP_STORAGE_MAX_ROW_BYTES = 16 * 1024
export const MCP_APP_STORAGE_MAX_READ_ROWS = 200

export const mcpAppIdSchema = z.string().length(30).regex(/^cob_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
export const mcpAppRevisionIdSchema = z.string().length(30).regex(/^cov_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
const pluginIdSchema = z.string().length(30).regex(/^plg_[0-7][0-9a-hjkmnp-tv-z]{25}$/u)
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const titleSchema = z.string().trim().min(1).max(120)
const descriptionSchema = z.string().trim().max(2_000)
const textFallbackSchema = z.string().trim().min(1).max(8_000)
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

/** A public App's friendly URL name: 3 to 48 lowercase letters, digits and hyphens. It can never look like an App id. */
export const mcpAppPublicNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/u)

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
 * `loadOnOpen` is the author's judgment that the tool only reads data the
 * person asked for, so it may run without a click even when its provider does
 * not mark it read-only, for everyone who opens the App. Den refuses it for
 * anything known to write, and for a connection tool bound directly and marked
 * destructive; a saved Workflow may read through one.
 */
export const mcpAppToolDeclarationSchema = z.object({
  name: mcpAppToolNameSchema,
  description: z.string().trim().min(1).max(1_000),
  capability: z.string().trim().min(1).max(512),
  mode: z.enum(["input", "live"]).optional(),
  loadOnOpen: z.boolean().optional(),
}).strict()

const toolDeclarationsSchema = z.array(mcpAppToolDeclarationSchema).max(MCP_APP_MAX_TOOLS)
  .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, "Tool names must be unique.")

const jsonSchemaObject = z.record(z.string(), z.json())
  .refine((schema) => schema.type === "object", "Tool input schemas must describe an object.")

/**
 * A declared tool resolved when the revision was published: how its arguments
 * reach the capability, the schema it advertises, whether Den verified it
 * as read-only, and whether its author chose to load it on open.
 */
export const mcpAppToolBindingSchema = z.object({
  name: mcpAppToolNameSchema,
  description: z.string().min(1).max(1_000),
  capability: z.string().min(1).max(512),
  kind: z.enum(["workflow", "mcp", "api"]),
  mode: z.enum(["input", "live"]),
  inputSchema: jsonSchemaObject,
  readOnly: z.boolean(),
  loadOnOpen: z.boolean().optional(),
  schemaDigest: digestSchema.optional(),
}).strict()

const storageNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u, "Use a lowercase snake_case name of at most 40 characters.")

/**
 * One value a saved row holds. `options` limits a text field to a fixed set,
 * such as the stages of a tracker. OpenWork checks every value against its
 * field before it is saved, so App code cannot store anything else.
 */
export const mcpAppStorageFieldSchema = z.object({
  name: storageNameSchema.refine((name) => name !== "id", "id is set by OpenWork."),
  type: z.enum(["text", "number", "boolean", "date"]),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
}).strict().refine((field) => field.options === undefined || field.type === "text", "Only a text field can have options.")

/**
 * A named set of rows in the App's own database. `scope` decides who sees a
 * row: `shared` (default) is everyone who can use the App, `personal` is only
 * the person who added it. `edit` decides who may change or remove a shared
 * row: `anyone` (default) who can use the App, or only its `creator`.
 * OpenWork enforces both on every read and write.
 */
export const mcpAppStorageCollectionSchema = z.object({
  name: storageNameSchema,
  description: z.string().trim().max(300).optional(),
  fields: z.array(mcpAppStorageFieldSchema).min(1).max(MCP_APP_STORAGE_MAX_FIELDS)
    .refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length, "Field names must be unique."),
  scope: z.enum(["shared", "personal"]).optional(),
  edit: z.enum(["anyone", "creator"]).optional(),
}).strict()

/** What an App saves. The data belongs to the App, not to one revision: updating the App keeps its rows. */
export const mcpAppStorageSchema = z.object({
  collections: z.array(mcpAppStorageCollectionSchema).min(1).max(MCP_APP_STORAGE_MAX_COLLECTIONS)
    .refine((collections) => new Set(collections.map((collection) => collection.name)).size === collections.length, "Collection names must be unique."),
}).strict()

const storageValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const mcpAppStorageReadInputSchema = z.object({
  collection: storageNameSchema,
  where: z.record(z.string(), storageValueSchema).optional(),
  orderBy: z.string().max(40).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(MCP_APP_STORAGE_MAX_READ_ROWS).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
}).strict()

export const mcpAppStorageWriteInputSchema = z.object({
  collection: storageNameSchema,
  action: z.enum(["insert", "update", "delete"]),
  id: z.string().min(1).max(64).optional(),
  values: z.record(z.string(), storageValueSchema).optional(),
}).strict()

export const mcpAppStorageRowSchema = z.object({
  id: z.string(),
  values: z.record(z.string(), storageValueSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  updatedBy: z.string(),
  mine: z.boolean(),
}).strict()

export const mcpAppStorageReadOutputSchema = z.object({
  collection: z.string(),
  rows: z.array(mcpAppStorageRowSchema),
  total: z.number().int().min(0),
  limit: z.number().int(),
  offset: z.number().int(),
}).strict()

export const mcpAppStorageWriteOutputSchema = z.object({
  collection: z.string(),
  action: z.enum(["insert", "update", "delete"]),
  id: z.string(),
  row: mcpAppStorageRowSchema.optional(),
}).strict()

/**
 * What the launch result tells an App about its saved data. `available: false`
 * means the data is kept but cannot be read or changed right now, and the App
 * says so instead of showing an empty list.
 */
export const mcpAppStorageStatusSchema = z.object({
  available: z.boolean(),
  collections: z.array(z.string()),
}).strict()

export const mcpAppAuthoringSchema = mcpAppSourceSchema.extend({
  title: titleSchema,
  description: descriptionSchema.optional(),
  cssSource: mcpAppSourceSchema.shape.cssSource.optional(),
  textFallback: textFallbackSchema,
  tools: toolDeclarationsSchema.optional(),
  public: z.boolean().optional(),
  site: z.boolean().optional(),
  publicName: mcpAppPublicNameSchema.optional(),
  storage: mcpAppStorageSchema.optional(),
})

/** Correlates preparation and publication in chat; it grants no access or validation. */
export const prepareMcpAppInputSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.optional(),
  tools: toolDeclarationsSchema.optional(),
  storage: mcpAppStorageSchema.optional(),
}).strict()
export const prepareMcpAppOutputSchema = z.object({
  preparationId: z.uuid(),
  title: titleSchema,
  tools: z.array(mcpAppToolBindingSchema).max(MCP_APP_MAX_TOOLS),
  starter: mcpAppSourceSchema,
  nextSteps: z.array(z.string()).max(6),
}).strict()
export const createMcpAppInputSchema = mcpAppAuthoringSchema.extend({
  pluginId: pluginIdSchema.optional(),
  preparationId: z.uuid().optional(),
})
export const updateMcpAppInputSchema = mcpAppAuthoringSchema.extend({
  appId: mcpAppIdSchema,
  expectedRevisionId: mcpAppRevisionIdSchema,
  /** Omit to keep what the App saves; null stops it using saved data, which is kept until the App is deleted. */
  storage: mcpAppStorageSchema.nullable().optional(),
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
  loadsWithLaunch: z.literal(true).optional(),
  public: z.literal(true).optional(),
  site: z.literal(true).optional(),
  storage: mcpAppStorageSchema.optional(),
}).strict().refine((value) => byteLength(JSON.stringify(value)) <= MCP_APP_MAX_STORAGE_BYTES)

export const mcpAppToolSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  capability: z.string(),
  mode: z.enum(["input", "live"]),
  readOnly: z.boolean(),
  loadOnOpen: z.boolean().optional(),
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
  storage: mcpAppStorageSchema.optional(),
}).strict()

export type McpAppSummary = z.infer<typeof mcpAppSummarySchema>
export type McpAppToolDeclaration = z.infer<typeof mcpAppToolDeclarationSchema>
export type McpAppToolBinding = z.infer<typeof mcpAppToolBindingSchema>
export type McpAppCompiledRevision = z.infer<typeof mcpAppCompiledRevisionSchema>
export type McpAppSource = z.infer<typeof mcpAppSourceSchema>
export type McpAppCsp = z.infer<typeof mcpAppCspSchema>
export type CreateMcpAppInput = z.infer<typeof createMcpAppInputSchema>
export type PrepareMcpAppInput = z.infer<typeof prepareMcpAppInputSchema>
export type PrepareMcpAppOutput = z.infer<typeof prepareMcpAppOutputSchema>
export type UpdateMcpAppInput = z.infer<typeof updateMcpAppInputSchema>
export type ReadMcpAppInput = z.infer<typeof readMcpAppInputSchema>
export type ReadMcpAppOutput = z.infer<typeof readMcpAppOutputSchema>
export type McpAppStorage = z.infer<typeof mcpAppStorageSchema>
export type McpAppStorageCollection = z.infer<typeof mcpAppStorageCollectionSchema>
export type McpAppStorageField = z.infer<typeof mcpAppStorageFieldSchema>
export type McpAppStorageReadInput = z.infer<typeof mcpAppStorageReadInputSchema>
export type McpAppStorageWriteInput = z.infer<typeof mcpAppStorageWriteInputSchema>
export type McpAppStorageRow = z.infer<typeof mcpAppStorageRowSchema>
export type McpAppStorageReadOutput = z.infer<typeof mcpAppStorageReadOutputSchema>
export type McpAppStorageWriteOutput = z.infer<typeof mcpAppStorageWriteOutputSchema>
export type McpAppStorageStatus = z.infer<typeof mcpAppStorageStatusSchema>

/**
 * Each App is served as its own MCP server beside directly exposed Connect
 * connections, so released clients and OAuth resource matching treat it like
 * any other connection endpoint under /mcp/agent.
 */
export function mcpAppServerPath(appId: string): string {
  return `/mcp/agent/connections/${mcpAppIdSchema.parse(appId)}`
}

/** Where an App marked public is served to anyone, outside the /mcp/agent OAuth resource. */
export function mcpAppPublicPath(appIdOrName: string): string {
  return `/mcp/public/apps/${z.union([mcpAppIdSchema, mcpAppPublicNameSchema]).parse(appIdOrName)}`
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

/**
 * The resource's identity across revisions: every revision of an App built in
 * OpenWork is the same App, so its revision is dropped only when the launch
 * connection is that App. Connected-provider resources keep their exact URI.
 */
export function mcpAppResourceIdentity(uri: string, connectionId?: string): string {
  const app = parseMcpAppResourceUri(uri)
  return app && connectionId === app.appId ? `ui://openwork/apps/${app.appId}` : uri
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
      ...(tool.loadOnOpen ? { loadOnOpen: true } : {}),
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
