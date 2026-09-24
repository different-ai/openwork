import { createHash } from "node:crypto"
import { and, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, ConfigObjectVersionTable, PluginTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  createMcpAppInputSchema,
  MCP_APP_CONFIG_SCHEMA_VERSION,
  MCP_APP_MAX_STORAGE_BYTES,
  MCP_APP_PAYLOAD_KIND,
  mcpAppCompiledRevisionSchema,
  mcpAppSourceSchema,
  summarizeMcpAppRevision,
  updateMcpAppInputSchema,
  type CreateMcpAppInput,
  type McpAppCompiledRevision,
  type McpAppCsp,
  type McpAppSummary,
  type ReadMcpAppOutput,
  type UpdateMcpAppInput,
} from "@openwork/types/mcp-app"
import { db } from "./db.js"
import { buildGeneratedMcpApp, type GeneratedArtifactViewBuildResult } from "./generated-artifact-view-builder.js"
import type { McpMemberIdentity } from "./mcp/external-capabilities.js"
import { listAccessibleMarketplaceCapabilityReferences } from "./mcp/marketplace-capabilities.js"
import {
  pluginArchResourceHasExpandedAudience,
  requirePluginArchResourceRole,
  type PluginArchActorContext,
} from "./routes/org/plugin-system/access.js"
import { createConfigObject, createPlugin, INTERNAL_MCP_APP_WRITE } from "./routes/org/plugin-system/store.js"

export class McpAppError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422, readonly code: string, message: string) {
    super(message)
    this.name = "McpAppError"
  }
}

type Revision = typeof ConfigObjectVersionTable.$inferSelect
type DatabaseReader = Pick<typeof db, "select">
export type McpAppAccessInput = { organizationId: string; member: McpMemberIdentity | null; enabled?: boolean }
export type McpAppResource = { app: McpAppSummary; html: string; csp: McpAppCsp; resourceDigest: string }

function notFound(): never {
  throw new McpAppError(404, "mcp_app_not_found", "MCP App or revision is not available.")
}

function appId(value: string) {
  try {
    return normalizeDenTypeId("configObject", value)
  } catch {
    return notFound()
  }
}

function revisionId(value: string) {
  try {
    return normalizeDenTypeId("configObjectVersion", value)
  } catch {
    return notFound()
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function sourceDigest(input: { compilerVersion: string; reactSource: string; cssSource: string; title: string; description: string | null }): string {
  return digest(JSON.stringify([
    "mcp-app", input.compilerVersion, input.reactSource, input.cssSource, input.title, input.description,
  ]))
}

function compiledRevision(row: Revision): McpAppCompiledRevision | null {
  if (row.isDeletedVersion || row.schemaVersion !== MCP_APP_CONFIG_SCHEMA_VERSION) return null
  const parsed = mcpAppCompiledRevisionSchema.safeParse(row.normalizedPayloadJson)
  return parsed.success ? parsed.data : null
}

async function activeApp(organizationId: DenTypeId<"organization">, id: DenTypeId<"configObject">, reader: DatabaseReader = db) {
  const [row] = await reader.select().from(ConfigObjectTable).where(and(
    eq(ConfigObjectTable.organizationId, organizationId),
    eq(ConfigObjectTable.id, id),
    eq(ConfigObjectTable.objectType, "app"),
    eq(ConfigObjectTable.status, "active"),
    isNull(ConfigObjectTable.deletedAt),
  )).limit(1)
  return row ?? null
}

async function latestRevision(organizationId: DenTypeId<"organization">, id: DenTypeId<"configObject">, reader: DatabaseReader = db) {
  const [row] = await reader.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, organizationId),
    eq(ConfigObjectVersionTable.configObjectId, id),
  )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id)).limit(1)
  return row ?? null
}

async function requireEditor(context: PluginArchActorContext, id: DenTypeId<"configObject">, write: boolean) {
  await requirePluginArchResourceRole({
    context,
    resourceId: id,
    resourceKind: "config_object",
    role: "editor",
    requireFreshSession: write && await pluginArchResourceHasExpandedAudience({ context, resourceId: id, resourceKind: "config_object" }),
  })
}

async function editableApp(context: PluginArchActorContext, id: DenTypeId<"configObject">, write: boolean) {
  const organizationId = context.organizationContext.organization.id
  const row = await activeApp(organizationId, id)
  if (!row) return notFound()
  await requireEditor(context, row.id, write)
  const version = await latestRevision(organizationId, row.id)
  const payload = version && compiledRevision(version)
  if (!version || !payload) return notFound()
  return { row, version, payload }
}

async function editablePlugin(context: PluginArchActorContext, id: string) {
  let pluginId: DenTypeId<"plugin">
  try {
    pluginId = normalizeDenTypeId("plugin", id)
  } catch {
    throw new McpAppError(404, "plugin_not_found", "Plugin is not available.")
  }
  const [plugin] = await db.select().from(PluginTable).where(and(
    eq(PluginTable.organizationId, context.organizationContext.organization.id),
    eq(PluginTable.id, pluginId),
    eq(PluginTable.status, "active"),
    isNull(PluginTable.deletedAt),
  )).limit(1)
  if (!plugin) throw new McpAppError(404, "plugin_not_found", "Plugin is not available.")
  await requirePluginArchResourceRole({
    context,
    resourceId: pluginId,
    resourceKind: "plugin",
    role: "editor",
    requireFreshSession: await pluginArchResourceHasExpandedAudience({ context, resourceId: pluginId, resourceKind: "plugin" }),
  })
  return pluginId
}

function compileFailure(result?: GeneratedArtifactViewBuildResult): McpAppError {
  const diagnostic = result?.diagnostics[0]
  const location = diagnostic?.line != null ? ` at line ${diagnostic.line}${diagnostic.column != null ? `, column ${diagnostic.column}` : ""}` : ""
  const hint = diagnostic?.message.includes("cannot use") || diagnostic?.message.includes("cannot import")
    ? "Use React rendering and the supplied App bridge; external resources, host globals, imports, and dynamic code are not supported."
    : diagnostic?.message.includes("exceeds") || diagnostic?.message.includes("time limit")
      ? "Reduce the source or compiled App size and complexity."
      : "Check React/TSX syntax and provide a default-exported React component."
  return new McpAppError(422, "mcp_app_compile_failed", `MCP App compilation failed${location}. ${hint} No revision was published.`)
}

async function compile(input: CreateMcpAppInput, pluginId: string) {
  const reactSource = input.reactSource.trim()
  const cssSource = input.cssSource?.trim() ?? ""
  const description = input.description?.trim() || null
  let result: GeneratedArtifactViewBuildResult
  try {
    result = await buildGeneratedMcpApp({ reactSource, cssSource, title: input.title, description })
  } catch {
    throw compileFailure()
  }
  if (!result.ok) throw compileFailure(result)
  const parsed = mcpAppCompiledRevisionSchema.safeParse({
    kind: MCP_APP_PAYLOAD_KIND,
    schemaVersion: 1,
    pluginId,
    title: input.title,
    description,
    textFallback: input.textFallback,
    html: result.html,
    htmlBytes: result.htmlBytes,
    resourceDigest: result.resourceDigest,
    sourceDigest: result.sourceDigest,
    csp: result.csp,
    compilerName: result.compilerName,
    compilerVersion: result.compilerVersion,
    reactVersion: result.reactVersion,
  })
  if (!parsed.success) throw new McpAppError(422, "mcp_app_invalid_build", "The compiler did not produce a valid bounded MCP App revision. No revision was published.")
  const payload = parsed.data
  if (payload.resourceDigest !== digest(payload.html)
    || payload.htmlBytes !== Buffer.byteLength(payload.html)
    || payload.sourceDigest !== sourceDigest({ ...payload, reactSource, cssSource })) {
    throw new McpAppError(422, "mcp_app_invalid_build", "The compiled MCP App failed its integrity check. No revision was published.")
  }
  const rawSourceText = JSON.stringify({ reactSource, cssSource })
  if (Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(rawSourceText) > MCP_APP_MAX_STORAGE_BYTES) {
    throw new McpAppError(413, "mcp_app_too_large", "The encoded MCP App revision and source must fit within 1 MiB. Reduce its size; no revision was published.")
  }
  return { payload, rawSourceText }
}

export async function createMcpApp({ context, ...source }: CreateMcpAppInput & { context: PluginArchActorContext }): Promise<McpAppSummary> {
  const parsed = createMcpAppInputSchema.safeParse(source)
  if (!parsed.success) throw new McpAppError(400, "invalid_mcp_app_input", "Provide a title, complete React/CSS source, and a non-empty text fallback within the App size limits.")
  const input = parsed.data
  let pluginId = input.pluginId ? await editablePlugin(context, input.pluginId) : null
  const compiled = await compile(input, pluginId ?? createDenTypeId("plugin"))
  if (pluginId) {
    await editablePlugin(context, pluginId)
  } else {
    const plugin = await createPlugin({ context, name: input.title, description: input.description })
    pluginId = plugin.id
  }
  const payload = { ...compiled.payload, pluginId }
  const saved = await createConfigObject({
    context,
    objectType: "app",
    pluginIds: [pluginId],
    sourceMode: "cloud",
    value: {
      metadata: { title: payload.title, description: payload.description },
      normalizedPayloadJson: payload,
      rawSourceText: compiled.rawSourceText,
      schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION,
    },
  }, INTERNAL_MCP_APP_WRITE)
  if (!saved.latestVersion) throw new McpAppError(422, "mcp_app_save_failed", "The MCP App revision could not be retrieved.")
  return summarizeMcpAppRevision({ appId: saved.id, revisionId: saved.latestVersion.id, payload })
}

export async function updateMcpApp({ context, ...source }: UpdateMcpAppInput & { context: PluginArchActorContext }): Promise<McpAppSummary> {
  const parsed = updateMcpAppInputSchema.safeParse(source)
  if (!parsed.success) throw new McpAppError(400, "invalid_mcp_app_input", "Provide appId, expectedRevisionId, and complete replacement App source, title, and text fallback.")
  const input = parsed.data
  const id = appId(input.appId)
  const expectedId = revisionId(input.expectedRevisionId)
  const current = await editableApp(context, id, true)
  if (current.version.id !== expectedId) throw new McpAppError(409, "mcp_app_revision_conflict", "This MCP App has changed. Read it again before updating.")
  const compiled = await compile(input, current.payload.pluginId)
  const organizationId = context.organizationContext.organization.id
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(ConfigObjectTable).where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.id, id),
    )).limit(1).for("update")
    if (!locked || locked.objectType !== "app" || locked.status !== "active" || locked.deletedAt) return notFound()
    await requireEditor(context, id, true)
    const latest = await latestRevision(organizationId, id, tx)
    if (!latest || latest.id !== expectedId || !compiledRevision(latest)) {
      throw new McpAppError(409, "mcp_app_revision_conflict", "This MCP App has changed. Read it again before updating.")
    }
    const now = new Date(Math.max(Date.now(), latest.createdAt.getTime() + 1))
    const newRevisionId = createDenTypeId("configObjectVersion")
    await tx.insert(ConfigObjectVersionTable).values({
      id: newRevisionId,
      configObjectId: id,
      organizationId,
      createdAt: now,
      createdByOrgMembershipId: context.organizationContext.currentMember.id,
      createdVia: "cloud",
      isDeletedVersion: false,
      normalizedPayloadJson: compiled.payload,
      rawSourceText: compiled.rawSourceText,
      schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
    })
    await tx.update(ConfigObjectTable).set({
      title: compiled.payload.title,
      description: compiled.payload.description,
      searchText: [compiled.payload.title, compiled.payload.description].filter(Boolean).join("\n"),
      updatedAt: now,
    }).where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.id, id)))
    return summarizeMcpAppRevision({ appId: id, revisionId: newRevisionId, payload: compiled.payload })
  })
}

export async function readMcpApp(input: { context: PluginArchActorContext; appId: string }): Promise<ReadMcpAppOutput> {
  const { version, payload } = await editableApp(input.context, appId(input.appId), false)
  let source: unknown
  try {
    source = JSON.parse(version.rawSourceText ?? "")
  } catch {
    throw new McpAppError(422, "mcp_app_invalid_source", "The stored App source is invalid.")
  }
  const parsed = mcpAppSourceSchema.safeParse(source)
  if (!parsed.success || sourceDigest({ ...payload, ...parsed.data }) !== payload.sourceDigest) {
    throw new McpAppError(422, "mcp_app_invalid_source", "The stored App source failed its integrity check.")
  }
  return { app: summarizeMcpAppRevision({ appId: version.configObjectId, revisionId: version.id, payload }), ...parsed.data }
}

export async function listAccessibleMcpApps(input: McpAppAccessInput): Promise<McpAppSummary[]> {
  const references = await listAccessibleMarketplaceCapabilityReferences(input)
  const apps = new Map<string, string>()
  for (const reference of references) {
    if (reference.objectType === "app" && !apps.has(reference.configObjectId)) apps.set(reference.configObjectId, reference.pluginId)
  }
  if (apps.size === 0) return []
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const summaries = await Promise.all([...apps].map(async ([id, pluginId]) => {
    const row = await activeApp(organizationId, appId(id))
    if (!row) return null
    const version = await latestRevision(organizationId, row.id)
    const payload = version && compiledRevision(version)
    return version && payload ? summarizeMcpAppRevision({ appId: row.id, revisionId: version.id, pluginId, payload }) : null
  }))
  return summaries.filter((summary): summary is McpAppSummary => summary !== null)
    .sort((left, right) => left.title.localeCompare(right.title) || left.appId.localeCompare(right.appId))
}

export async function loadMcpAppResource(input: McpAppAccessInput & { appId: string; revisionId: string }): Promise<McpAppResource> {
  const id = appId(input.appId)
  const versionId = revisionId(input.revisionId)
  const reference = (await listAccessibleMarketplaceCapabilityReferences(input))
    .find((entry) => entry.objectType === "app" && entry.configObjectId === id)
  if (!reference) return notFound()
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!await activeApp(organizationId, id)) return notFound()
  const current = await latestRevision(organizationId, id)
  if (!current || !compiledRevision(current)) return notFound()
  const version = current.id === versionId ? current : (await db.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, organizationId),
    eq(ConfigObjectVersionTable.configObjectId, id),
    eq(ConfigObjectVersionTable.id, versionId),
  )).limit(1))[0]
  const payload = version && compiledRevision(version)
  if (!version || !payload) return notFound()
  if (digest(payload.html) !== payload.resourceDigest || Buffer.byteLength(payload.html) !== payload.htmlBytes) {
    throw new McpAppError(422, "mcp_app_digest_mismatch", "The MCP App revision failed its integrity check.")
  }
  return {
    app: summarizeMcpAppRevision({ appId: id, revisionId: version.id, pluginId: reference.pluginId, payload }),
    html: payload.html,
    csp: payload.csp,
    resourceDigest: payload.resourceDigest,
  }
}
