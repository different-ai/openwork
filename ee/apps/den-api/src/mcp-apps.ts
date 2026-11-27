import { PerformanceObserver } from "node:perf_hooks";
import { timeMcpApp } from "@openwork/types/mcp-app-timing";
import { createHash } from "node:crypto"
import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, ConfigObjectVersionTable, PluginConfigObjectTable, PluginTable, PublicMcpAppNameTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  createMcpAppInputSchema,
  MCP_APP_CONFIG_SCHEMA_VERSION,
  MCP_APP_INITIAL_RESULTS_META,
  MCP_APP_MAX_STORAGE_BYTES,
  MCP_APP_PAYLOAD_KIND,
  MCP_APP_STORAGE_READ_TOOL_NAME,
  MCP_APP_STORAGE_WRITE_TOOL_NAME,
  mcpAppCompiledRevisionSchema,
  mcpAppIdSchema,
  mcpAppPublicNameSchema,
  mcpAppServerPath,
  mcpAppSourceSchema,
  summarizeMcpAppRevision,
  updateMcpAppInputSchema,
  type CreateMcpAppInput,
  type McpAppCompiledRevision,
  type McpAppCsp,
  type McpAppSource,
  type McpAppStorage,
  type McpAppSummary,
  type McpAppToolBinding,
  type McpAppToolDeclaration,
  type ReadMcpAppOutput,
  type UpdateMcpAppInput,
} from "@openwork/types/mcp-app"
import { db } from "./db.js"
import { env } from "./env.js"
import { withPrimaryReads } from "./read-routing.js"
import { buildGeneratedMcpApp, type GeneratedArtifactViewBuildResult } from "./generated-artifact-view-builder.js"
import type { McpMemberIdentity } from "./mcp/external-capabilities.js"
import { buildMarketplaceCapabilityName, listAccessibleMarketplaceCapabilityReferences, listAccessibleMarketplaceCapabilityReferencesFor, parseMarketplaceCapabilityName } from "./mcp/marketplace-capabilities.js"
import {
  PluginArchAuthorizationError,
  requirePluginArchResourceRole,
  type PluginArchActorContext,
} from "./routes/org/plugin-system/access.js"
import {
  attachConfigObjectToPlugin,
  createConfigObject,
  createPlugin,
  INTERNAL_MCP_APP_WRITE,
  PluginArchRouteFailure,
  setPluginLifecycle,
} from "./routes/org/plugin-system/store.js"

export class McpAppError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422, readonly code: string, message: string) {
    super(message)
    this.name = "McpAppError"
  }
}

type Revision = typeof ConfigObjectVersionTable.$inferSelect
type DatabaseReader = Pick<typeof db, "select">
export type McpAppAccessInput = { organizationId: string; member: McpMemberIdentity | null; requestScope?: object }
export type McpAppResource = { app: McpAppSummary; html: string; csp: McpAppCsp; resourceDigest: string }
export type McpAppEntry = { appId: string; pluginId: string; revisionId: string; title: string; description: string | null; serverPath: string }
export type McpAppServerDefinition = { app: McpAppSummary; tools: McpAppToolBinding[]; loadsWithLaunch?: boolean; site?: boolean; storage?: McpAppStorage }
export type ResolveMcpAppTools = (tools: McpAppToolDeclaration[]) => Promise<McpAppToolBinding[]>

function notFound(): never {
  throw new McpAppError(404, "mcp_app_not_found", "Artifact or revision is not available.")
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

async function requireEditor(context: PluginArchActorContext, id: DenTypeId<"configObject">) {
  await requirePluginArchResourceRole({ context, resourceId: id, resourceKind: "config_object", role: "editor" })
}

async function editableApp(context: PluginArchActorContext, id: DenTypeId<"configObject">) {
  const organizationId = context.organizationContext.organization.id
  const row = await activeApp(organizationId, id)
  if (!row) return notFound()
  await requireEditor(context, row.id)
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
  await requirePluginArchResourceRole({ context, resourceId: pluginId, resourceKind: "plugin", role: "editor" })
  return pluginId
}

const BUILDER_POLICY_MESSAGE = /^Generated [^.]* cannot /u
const BUILDER_LIMIT_MESSAGE = /^(?:(?:React|CSS) source exceeds \d+ bytes\.|Compiled MCP App exceeds \d+ bytes\.(?: Compiled size: \d+ bytes\.)?|React view build exceeded the server time limit\.)$/u

function compileFailure(result?: GeneratedArtifactViewBuildResult): McpAppError {
  const diagnostic = result?.diagnostics[0]
  const location = diagnostic?.line != null ? ` at line ${diagnostic.line}${diagnostic.column != null ? `, column ${diagnostic.column}` : ""}` : ""
  const hint = diagnostic && BUILDER_POLICY_MESSAGE.test(diagnostic.message)
    ? diagnostic.message
    : diagnostic && BUILDER_LIMIT_MESSAGE.test(diagnostic.message)
      ? `${diagnostic.message} Reduce the source or compiled artifact size and complexity.`
      : "Check React/TSX syntax and provide a default-exported React component."
  return new McpAppError(422, "mcp_app_compile_failed", `Artifact compilation failed${location}. ${hint} No revision was published.`)
}

function storedSource(version: Revision, payload: McpAppCompiledRevision): McpAppSource {
  let source: unknown
  try {
    source = JSON.parse(version.rawSourceText ?? "")
  } catch {
    throw new McpAppError(422, "mcp_app_invalid_source", "The stored artifact source is invalid.")
  }
  const parsed = mcpAppSourceSchema.safeParse(source)
  if (!parsed.success || sourceDigest({ ...payload, ...parsed.data }) !== payload.sourceDigest) {
    throw new McpAppError(422, "mcp_app_invalid_source", "The stored artifact source failed its integrity check.")
  }
  return parsed.data
}

type WorkflowTool = { tool: McpAppToolBinding; workflowId: DenTypeId<"configObject"> }

function workflowTools(tools: McpAppToolBinding[]): WorkflowTool[] {
  return tools.flatMap((tool) => {
    const parsed = tool.kind === "workflow" ? parseMarketplaceCapabilityName(tool.capability) : null
    return parsed ? [{ tool, workflowId: normalizeDenTypeId("configObject", parsed.configObjectId) }] : []
  })
}

async function workflowsToAdd(context: PluginArchActorContext, pluginId: DenTypeId<"plugin"> | null, tools: WorkflowTool[]): Promise<DenTypeId<"configObject">[]> {
  const ids = [...new Set(tools.map((entry) => entry.workflowId))]
  const present = new Set(pluginId && ids.length > 0 ? (await db.select({ id: PluginConfigObjectTable.configObjectId }).from(PluginConfigObjectTable).where(and(
    eq(PluginConfigObjectTable.organizationId, context.organizationContext.organization.id),
    eq(PluginConfigObjectTable.pluginId, pluginId),
    inArray(PluginConfigObjectTable.configObjectId, ids),
    isNull(PluginConfigObjectTable.removedAt),
  ))).map((row) => row.id) : [])
  const missing = ids.filter((id) => !present.has(id))
  for (const id of missing) {
    try {
      await requirePluginArchResourceRole({ context, resourceId: id, resourceKind: "config_object", role: "manager" })
    } catch (error) {
      if (!(error instanceof PluginArchAuthorizationError) || error.error !== "forbidden") throw error
      const name = tools.find((entry) => entry.workflowId === id)?.tool.name
      throw new McpAppError(422, "mcp_app_tool_unavailable", `Tool ${name}: sharing an artifact shares the Workflows its tools run, so only a manager of this Workflow can add it to an artifact. Bind a Workflow you manage, or ask its owner to add it. No revision was published.`)
    }
  }
  return missing
}

function throughPlugin(tools: McpAppToolBinding[], pluginId: string): McpAppToolBinding[] {
  return tools.map((tool) => {
    const parsed = tool.kind === "workflow" ? parseMarketplaceCapabilityName(tool.capability) : null
    return parsed ? { ...tool, capability: buildMarketplaceCapabilityName(pluginId, parsed.configObjectId) } : tool
  })
}

async function addWorkflows(context: PluginArchActorContext, pluginId: DenTypeId<"plugin">, workflowIds: DenTypeId<"configObject">[]) {
  for (const configObjectId of workflowIds) await attachConfigObjectToPlugin({ context, configObjectId, pluginId })
}

async function requirePublishable(tools: McpAppToolBinding[], storage: McpAppStorage | undefined) {
  if (tools.length > 0) {
    throw new McpAppError(409, "public_app_has_tools", "A public artifact cannot have tools, because visitors are not signed in. Remove its tools (tools: []) or pass public: false. No revision was published.")
  }
  if (storage) {
    throw new McpAppError(409, "public_app_has_storage", "A public artifact cannot save data, because visitors are not signed in. Remove its storage or pass public: false. No revision was published.")
  }
}

function requireStorage(input: { declared: McpAppStorage | null | undefined; current: McpAppStorage | undefined; enabled: boolean; tools: McpAppToolDeclaration[] | McpAppToolBinding[] }): McpAppStorage | undefined {
  const storage = input.declared === undefined ? input.current : input.declared ?? undefined
  if (input.declared && !input.enabled) {
    throw new McpAppError(409, "artifact_storage_off", "Artifacts that save data are not turned on for this organization. Leave storage out, or ask an OpenWork admin to turn it on. No revision was published.")
  }
  if (storage) {
    const reserved = input.tools.find((tool) => tool.name === MCP_APP_STORAGE_READ_TOOL_NAME || tool.name === MCP_APP_STORAGE_WRITE_TOOL_NAME)
    if (reserved) throw new McpAppError(400, "invalid_mcp_app_input", `${reserved.name} is the name of a tool OpenWork gives an artifact that saves data. Rename your tool. No revision was published.`)
  }
  return storage
}

function publicNameTaken(name: string, saved: boolean): McpAppError {
  return new McpAppError(409, "public_name_taken", saved
    ? `The artifact was saved and is public at its original URL, but the public name "${name}" was just taken. Choose another publicName with update_app.`
    : `The public name "${name}" is already used by another artifact. Choose another publicName. No revision was published.`)
}

async function requirePublicNameFree(input: { name: string; isPublic: boolean; appId: DenTypeId<"configObject"> | null }) {
  if (!input.isPublic) {
    throw new McpAppError(409, "public_name_needs_public", "publicName names a public artifact's URL. Pass public: true with it, or omit publicName. No revision was published.")
  }
  const [row] = await db.select({ appId: PublicMcpAppNameTable.configObjectId }).from(PublicMcpAppNameTable)
    .where(eq(PublicMcpAppNameTable.name, input.name)).limit(1)
  if (row && row.appId !== input.appId) throw publicNameTaken(input.name, false)
}

async function savePublicName(organizationId: DenTypeId<"organization">, id: DenTypeId<"configObject">, name: string) {
  try {
    const [current] = await db.select({ name: PublicMcpAppNameTable.name }).from(PublicMcpAppNameTable)
      .where(eq(PublicMcpAppNameTable.configObjectId, id)).limit(1)
    if (current?.name === name) return
    if (current) await db.update(PublicMcpAppNameTable).set({ name }).where(eq(PublicMcpAppNameTable.configObjectId, id))
    else await db.insert(PublicMcpAppNameTable).values({ name, organizationId, configObjectId: id })
  } catch (error) {
    if (isDuplicateEntry(error)) throw publicNameTaken(name, true)
    throw error
  }
}

const DUPLICATE_ENTRY_MESSAGE = /\bDuplicate entry\b|\(errno 1062\)/

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "ER_DUP_ENTRY") return true
  if ("errno" in error && error.errno === 1062) return true
  if ("message" in error && typeof error.message === "string" && DUPLICATE_ENTRY_MESSAGE.test(error.message)) return true
  return "cause" in error && error.cause !== error && isDuplicateEntry(error.cause)
}

async function compile(input: CreateMcpAppInput, pluginId: string, tools: McpAppToolBinding[], storage?: McpAppStorage) {
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
    tools,
    html: result.html,
    htmlBytes: result.htmlBytes,
    resourceDigest: result.resourceDigest,
    sourceDigest: result.sourceDigest,
    csp: result.csp,
    compilerName: result.compilerName,
    compilerVersion: result.compilerVersion,
    reactVersion: result.reactVersion,
    ...(reactSource.includes(MCP_APP_INITIAL_RESULTS_META) ? { loadsWithLaunch: true } : {}),
    ...(input.public ? { public: true } : {}),
    ...(input.site ? { site: true } : {}),
    ...(storage ? { storage } : {}),
  })
  if (!parsed.success) throw new McpAppError(422, "mcp_app_invalid_build", "The compiler did not produce a valid bounded artifact revision. No revision was published.")
  const payload = parsed.data
  if (payload.resourceDigest !== digest(payload.html)
    || payload.htmlBytes !== Buffer.byteLength(payload.html)
    || payload.sourceDigest !== sourceDigest({ ...payload, reactSource, cssSource })) {
    throw new McpAppError(422, "mcp_app_invalid_build", "The compiled artifact failed its integrity check. No revision was published.")
  }
  const rawSourceText = JSON.stringify({ reactSource, cssSource })
  const storageLimit = MCP_APP_MAX_STORAGE_BYTES
  if (Buffer.byteLength(JSON.stringify(payload)) + Buffer.byteLength(rawSourceText) > storageLimit) {
    throw new McpAppError(413, "mcp_app_too_large", `The encoded artifact revision and source must fit within ${storageLimit / 1024 / 1024} MiB. Reduce its size; no revision was published.`)
  }
  return { payload, rawSourceText }
}

type McpAppWriteInput<TInput> = TInput & {
  context: PluginArchActorContext
  resolveTools: ResolveMcpAppTools
  storageEnabled?: boolean
}

export function createMcpApp(input: McpAppWriteInput<CreateMcpAppInput>): Promise<McpAppSummary> {
  return withPrimaryReads(() => createMcpAppOnPrimary(input))
}

export function updateMcpApp(input: McpAppWriteInput<UpdateMcpAppInput>): Promise<McpAppSummary> {
  return withPrimaryReads(() => updateMcpAppOnPrimary(input))
}

async function createMcpAppOnPrimary({ context, resolveTools, storageEnabled, ...source }: McpAppWriteInput<CreateMcpAppInput>): Promise<McpAppSummary> {
  const parsed = createMcpAppInputSchema.safeParse(source)
  if (!parsed.success) throw new McpAppError(400, "invalid_mcp_app_input", "Provide a title, complete React/CSS source, a non-empty text fallback, and uniquely named tools within the artifact limits.")
  const input = parsed.data
  let pluginId = input.pluginId ? await editablePlugin(context, input.pluginId) : null
  const storage = requireStorage({ declared: input.storage, current: undefined, enabled: storageEnabled === true, tools: input.tools ?? [] })
  const resolved = await resolveTools(input.tools ?? [])
  if (input.public) await requirePublishable(resolved, storage)
  if (input.publicName) await requirePublicNameFree({ name: input.publicName, isPublic: input.public === true, appId: null })
  const workflows = await workflowsToAdd(context, pluginId, workflowTools(resolved))
  const compiled = await compile(input, pluginId ?? createDenTypeId("plugin"), resolved, storage)
  let createdPluginId: DenTypeId<"plugin"> | null = null
  if (pluginId) {
    await editablePlugin(context, pluginId)
  } else {
    try {
      const plugin = await createPlugin({ context, name: input.title, description: input.description })
      pluginId = createdPluginId = plugin.id
    } catch (error) {
      if (error instanceof PluginArchRouteFailure && error.error === "duplicate_plugin") {
        throw new McpAppError(409, "duplicate_plugin", `${error.message} To add this artifact to it, pass its pluginId; otherwise choose a different title. No artifact was created.`)
      }
      throw error
    }
  }
  const appPluginId = pluginId
  const discardPlugin = async () => {
    if (createdPluginId) await setPluginLifecycle({ action: "archive", context, pluginId: createdPluginId }).catch(() => undefined)
  }
  try {
    await addWorkflows(context, appPluginId, workflows)
  } catch (error) {
    await discardPlugin()
    throw error
  }
  const payload = { ...compiled.payload, pluginId: appPluginId, tools: throughPlugin(compiled.payload.tools, appPluginId) }
  const saved = await createConfigObject({
    context,
    objectType: "app",
    pluginIds: [appPluginId],
    sourceMode: "cloud",
    value: {
      metadata: { title: payload.title, description: payload.description },
      normalizedPayloadJson: payload,
      rawSourceText: compiled.rawSourceText,
      schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION,
    },
  }, INTERNAL_MCP_APP_WRITE).catch(async (error: unknown) => {
    await discardPlugin()
    throw error
  })
  if (!saved.latestVersion) throw new McpAppError(422, "mcp_app_save_failed", "The artifact revision could not be retrieved.")
  if (input.publicName) await savePublicName(context.organizationContext.organization.id, saved.id, input.publicName)
  return summarizeMcpAppRevision({ appId: saved.id, revisionId: saved.latestVersion.id, payload })
}

async function updateMcpAppOnPrimary({ context, resolveTools, storageEnabled, ...source }: McpAppWriteInput<UpdateMcpAppInput>): Promise<McpAppSummary> {
  const parsed = updateMcpAppInputSchema.safeParse(source)
  if (!parsed.success) throw new McpAppError(400, "invalid_mcp_app_input", "Provide appId, expectedRevisionId, and complete replacement artifact source, title, text fallback, and uniquely named tools.")
  const input = parsed.data
  const id = appId(input.appId)
  const expectedId = revisionId(input.expectedRevisionId)
  const current = await editableApp(context, id)
  if (current.version.id !== expectedId) throw new McpAppError(409, "mcp_app_revision_conflict", "This artifact has changed. Read it again before updating.")
  const pluginId = normalizeDenTypeId("plugin", current.payload.pluginId)
  const resolved = input.tools ? await resolveTools(input.tools) : current.payload.tools
  const isPublic = input.public ?? current.payload.public === true
  const storage = requireStorage({ declared: input.storage, current: current.payload.storage, enabled: storageEnabled === true, tools: resolved })
  if (isPublic) await requirePublishable(resolved, storage)
  const isSite = input.site ?? current.payload.site === true
  if (input.publicName) await requirePublicNameFree({ name: input.publicName, isPublic, appId: id })
  const workflows = input.tools ? await workflowsToAdd(context, pluginId, workflowTools(resolved)) : []
  const { storage: _declared, ...authored } = input
  const compiled = await compile({
    ...authored,
    public: isPublic,
    site: isSite,
    cssSource: input.cssSource ?? storedSource(current.version, current.payload).cssSource,
    description: input.description ?? current.payload.description ?? undefined,
  }, pluginId, throughPlugin(resolved, pluginId), storage)
  await requireEditor(context, id)
  await addWorkflows(context, pluginId, workflows)
  const organizationId = context.organizationContext.organization.id
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(ConfigObjectTable).where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.id, id),
    )).limit(1).for("update")
    if (!locked || locked.objectType !== "app" || locked.status !== "active" || locked.deletedAt) return notFound()
    const latest = await latestRevision(organizationId, id, tx)
    if (!latest || latest.id !== expectedId || !compiledRevision(latest)) {
      throw new McpAppError(409, "mcp_app_revision_conflict", "This artifact has changed. Read it again before updating.")
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
  if (input.publicName) await savePublicName(organizationId, id, input.publicName)
  return updated
}

type PublicSharingBlocker = "tools" | "storage"
type PublicSharingState = { appId: string; revisionId: string; public: boolean; canPublish: boolean; blockedBy: PublicSharingBlocker | null }

function publicSharingBlocker(payload: McpAppCompiledRevision): PublicSharingBlocker | null {
  if (payload.tools.length > 0) return "tools"
  return payload.storage ? "storage" : null
}

function publicSharingState(versionId: string, id: string, payload: McpAppCompiledRevision): PublicSharingState {
  const blockedBy = publicSharingBlocker(payload)
  const canPublish = blockedBy === null
  return { appId: id, revisionId: versionId, public: payload.public === true && canPublish, canPublish, blockedBy }
}

export function changeMcpAppPublicSharing(input: {
  context: PluginArchActorContext
  appId: string
  change?: { public: boolean; expectedRevisionId: string }
}): Promise<PublicSharingState> {
  return withPrimaryReads(async () => {
    if (!env.appMcpServersEnabled) return notFound()
    const id = appId(input.appId)
    const organizationId = input.context.organizationContext.organization.id
    if (!await activeApp(organizationId, id)) return notFound()
    await requirePluginArchResourceRole({ context: input.context, resourceId: id, resourceKind: "config_object", role: "manager" })
    const change = input.change
    if (!change) {
      const version = await latestRevision(organizationId, id)
      const payload = version && compiledRevision(version)
      if (!version || !payload) return notFound()
      return publicSharingState(version.id, id, payload)
    }
    return db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: ConfigObjectTable.id }).from(ConfigObjectTable).where(and(
        eq(ConfigObjectTable.organizationId, organizationId),
        eq(ConfigObjectTable.id, id),
        eq(ConfigObjectTable.objectType, "app"),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      )).limit(1).for("update")
      if (!locked) return notFound()
      const latest = await latestRevision(organizationId, id, tx)
      const payload = latest && compiledRevision(latest)
      if (!latest || !payload) return notFound()
      if (latest.id !== change.expectedRevisionId) {
        throw new McpAppError(409, "mcp_app_revision_conflict", "This artifact has changed. Review the latest version before changing its public link.")
      }
      if (change.public) {
        await requirePublishable(payload.tools, payload.storage)
        if (digest(payload.html) !== payload.resourceDigest || Buffer.byteLength(payload.html) !== payload.htmlBytes) {
          throw new McpAppError(422, "mcp_app_digest_mismatch", "The artifact revision failed its integrity check.")
        }
      }
      if ((payload.public === true) === change.public) return publicSharingState(latest.id, id, payload)
      const next: McpAppCompiledRevision = { ...payload }
      if (change.public) next.public = true
      else delete next.public
      const nextId = createDenTypeId("configObjectVersion")
      const now = new Date(Math.max(Date.now(), latest.createdAt.getTime() + 1))
      await tx.insert(ConfigObjectVersionTable).values({
        id: nextId,
        configObjectId: id,
        organizationId,
        createdAt: now,
        createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
        createdVia: "cloud",
        isDeletedVersion: false,
        normalizedPayloadJson: next,
        rawSourceText: latest.rawSourceText,
        schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION,
        connectorSyncEventId: null,
        sourceRevisionRef: null,
      })
      await tx.update(ConfigObjectTable).set({ updatedAt: now }).where(and(
        eq(ConfigObjectTable.organizationId, organizationId),
        eq(ConfigObjectTable.id, id),
      ))
      return publicSharingState(nextId, id, next)
    })
  })
}

export async function readMcpApp(input: { context: PluginArchActorContext; appId: string; storageEnabled?: boolean }): Promise<ReadMcpAppOutput> {
  const { version, payload } = await editableApp(input.context, appId(input.appId))
  const source = storedSource(version, payload)
  return {
    app: summarizeMcpAppRevision({ appId: version.configObjectId, revisionId: version.id, payload }),
    ...source,
    ...(input.storageEnabled && payload.storage ? { storage: payload.storage } : {}),
  }
}

async function accessibleAppPlugins(input: McpAppAccessInput): Promise<Map<string, string>> {
  const apps = new Map<string, string>()
  for (const reference of await timeMcpApp("den.marketplace-access-scan", () => listAccessibleMarketplaceCapabilityReferences(input))) {
    if (reference.objectType === "app" && !apps.has(reference.configObjectId)) apps.set(reference.configObjectId, reference.pluginId)
  }
  return apps
}

async function accessibleAppPlugin(input: McpAppAccessInput & { appId: string }): Promise<string | undefined> {
  const references = await timeMcpApp("den.app-access-check", () => listAccessibleMarketplaceCapabilityReferencesFor({ ...input, configObjectId: input.appId }))
  return references.find((reference) => reference.objectType === "app")?.pluginId
}

async function latestAuthoredApps(organizationId: DenTypeId<"organization">, ids: DenTypeId<"configObject">[]) {
  if (ids.length === 0) return []
  const rows = await db.select({ id: ConfigObjectTable.id, title: ConfigObjectTable.title, description: ConfigObjectTable.description })
    .from(ConfigObjectTable).where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      inArray(ConfigObjectTable.id, ids),
      eq(ConfigObjectTable.objectType, "app"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
  const versions = rows.length === 0 ? [] : await db.select({
    id: ConfigObjectVersionTable.id,
    configObjectId: ConfigObjectVersionTable.configObjectId,
    schemaVersion: ConfigObjectVersionTable.schemaVersion,
    isDeletedVersion: ConfigObjectVersionTable.isDeletedVersion,
  }).from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, organizationId),
    inArray(ConfigObjectVersionTable.configObjectId, rows.map((row) => row.id)),
  )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const latest = new Map<string, (typeof versions)[number]>()
  for (const version of versions) if (!latest.has(version.configObjectId)) latest.set(version.configObjectId, version)
  return rows.flatMap((row) => {
    const version = latest.get(row.id)
    if (!version || version.isDeletedVersion || version.schemaVersion !== MCP_APP_CONFIG_SCHEMA_VERSION) return []
    return [{ ...row, revisionId: version.id }]
  })
}

async function organizationHasApps(organizationId: DenTypeId<"organization">): Promise<boolean> {
  const [row] = await db.select({ id: ConfigObjectTable.id }).from(ConfigObjectTable).where(and(
    eq(ConfigObjectTable.organizationId, organizationId),
    eq(ConfigObjectTable.objectType, "app"),
    eq(ConfigObjectTable.status, "active"),
    isNull(ConfigObjectTable.deletedAt),
  )).limit(1)
  return row !== undefined
}

async function listAccessibleMcpAppsUntimed(input: McpAppAccessInput): Promise<McpAppEntry[]> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  if (!await organizationHasApps(organizationId)) return []
  const apps = await accessibleAppPlugins(input)
  if (apps.size === 0) return []
  return (await timeMcpApp("den.latest-authored-apps", () => latestAuthoredApps(organizationId, [...apps.keys()].map(appId)))).flatMap((row): McpAppEntry[] => {
    const pluginId = apps.get(row.id)
    return pluginId
      ? [{ appId: row.id, pluginId, revisionId: row.revisionId, title: row.title, description: row.description, serverPath: mcpAppServerPath(row.id) }]
      : []
  }).sort((left, right) => left.title.localeCompare(right.title) || left.appId.localeCompare(right.appId))
}

export function listAccessibleMcpApps(input: McpAppAccessInput): Promise<McpAppEntry[]> {
  return timeMcpApp("den.accessible-apps", () => listAccessibleMcpAppsUntimed(input))
}

export async function isActiveMcpApp(input: { organizationId: string; appId: string }): Promise<boolean> {
  const id = mcpAppIdSchema.safeParse(input.appId)
  if (!id.success) return false
  return await activeApp(normalizeDenTypeId("organization", input.organizationId), appId(id.data)) !== null
}

type RevisionHead = Pick<Revision, "id" | "schemaVersion" | "isDeletedVersion">
const revisionHeadColumns = {
  id: ConfigObjectVersionTable.id,
  schemaVersion: ConfigObjectVersionTable.schemaVersion,
  isDeletedVersion: ConfigObjectVersionTable.isDeletedVersion,
}

async function latestRevisionHead(organizationId: DenTypeId<"organization">, id: DenTypeId<"configObject">): Promise<RevisionHead | null> {
  const [row] = await db.select(revisionHeadColumns).from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.organizationId, organizationId),
    eq(ConfigObjectVersionTable.configObjectId, id),
  )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id)).limit(1)
  return row ?? null
}

type RevisionContent = { payload: McpAppCompiledRevision; bytes: number; intact?: boolean }
const REVISION_CONTENT_MAX_BYTES = 16 * 1024 * 1024
const REVISION_CONTENT_MAX_ENTRIES = 64
const revisionContents = new Map<string, RevisionContent>()
let revisionContentBytes = 0

async function revisionContent(organizationId: DenTypeId<"organization">, id: DenTypeId<"configObject">, head: RevisionHead): Promise<RevisionContent | null> {
  if (head.isDeletedVersion || head.schemaVersion !== MCP_APP_CONFIG_SCHEMA_VERSION) return null
  const key = `${organizationId}:${id}:${head.id}`
  const kept = revisionContents.get(key)
  if (kept) {
    revisionContents.delete(key)
    revisionContents.set(key, kept)
    return kept
  }
  const [row] = await db.select({ normalizedPayloadJson: ConfigObjectVersionTable.normalizedPayloadJson })
    .from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      eq(ConfigObjectVersionTable.configObjectId, id),
      eq(ConfigObjectVersionTable.id, head.id),
    )).limit(1)
  const parsed = row ? mcpAppCompiledRevisionSchema.safeParse(row.normalizedPayloadJson) : null
  if (!parsed?.success) return null
  const raced = revisionContents.get(key)
  if (raced) return raced
  const payload = parsed.data
  const content = { payload, bytes: payload.htmlBytes + Buffer.byteLength(JSON.stringify({ ...payload, html: "" })) }
  if (content.bytes > REVISION_CONTENT_MAX_BYTES) return content
  revisionContents.set(key, content)
  revisionContentBytes += content.bytes
  for (const [oldest, entry] of revisionContents) {
    if (revisionContentBytes <= REVISION_CONTENT_MAX_BYTES && revisionContents.size <= REVISION_CONTENT_MAX_ENTRIES) break
    revisionContents.delete(oldest)
    revisionContentBytes -= entry.bytes
  }
  return content
}

async function accessibleRevisionUncached(input: McpAppAccessInput & { appId: string }) {
  const id = appId(input.appId)
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const [pluginId, active, head] = await Promise.all([
    accessibleAppPlugin(input),
    activeApp(organizationId, id),
    latestRevisionHead(organizationId, id),
  ])
  if (!pluginId) return notFound()
  if (!active) return notFound()
  const content = head && await revisionContent(organizationId, id, head)
  if (!head || !content) return notFound()
  return { id, pluginId, organizationId, currentRevisionId: head.id, content }
}

const requestRevisions = new WeakMap<object, Map<string, ReturnType<typeof accessibleRevisionUncached>>>()
function accessibleRevision(input: McpAppAccessInput & { appId: string }) {
  if (!input.requestScope) return accessibleRevisionUncached(input)
  let revisions = requestRevisions.get(input.requestScope)
  if (!revisions) { revisions = new Map(); requestRevisions.set(input.requestScope, revisions) }
  const key = JSON.stringify([input.organizationId, input.member?.orgMembershipId, input.member?.teamIds, input.appId])
  let revision = revisions.get(key)
  if (!revision) { revision = accessibleRevisionUncached(input); revisions.set(key, revision) }
  return revision
}

export async function loadMcpAppServerDefinition(input: McpAppAccessInput & { appId: string }): Promise<McpAppServerDefinition> {
  const { id, pluginId, currentRevisionId, content: { payload } } = await accessibleRevision(input)
  return {
    app: summarizeMcpAppRevision({ appId: id, revisionId: currentRevisionId, pluginId, payload }),
    tools: payload.tools,
    ...(payload.loadsWithLaunch ? { loadsWithLaunch: true } : {}),
    ...(payload.site ? { site: true } : {}),
    ...(payload.storage ? { storage: payload.storage } : {}),
  }
}

export async function loadMcpAppResource(input: McpAppAccessInput & { appId: string; revisionId: string }): Promise<McpAppResource> {
  const versionId = revisionId(input.revisionId)
  const { id, pluginId, organizationId, currentRevisionId, content: current } = await accessibleRevision(input)
  let content: RevisionContent | null = current
  if (currentRevisionId !== versionId) {
    const [head] = await db.select(revisionHeadColumns).from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      eq(ConfigObjectVersionTable.configObjectId, id),
      eq(ConfigObjectVersionTable.id, versionId),
    )).limit(1)
    content = head ? await revisionContent(organizationId, id, head) : null
  }
  if (!content) return notFound()
  const { payload } = content
  content.intact ??= digest(payload.html) === payload.resourceDigest && Buffer.byteLength(payload.html) === payload.htmlBytes
  if (!content.intact) {
    throw new McpAppError(422, "mcp_app_digest_mismatch", "The artifact revision failed its integrity check.")
  }
  return {
    app: summarizeMcpAppRevision({ appId: id, revisionId: versionId, pluginId, payload }),
    html: payload.html,
    csp: payload.csp,
    resourceDigest: payload.resourceDigest,
  }
}

async function appIdForPublicPath(appIdOrName: string): Promise<DenTypeId<"configObject"> | null> {
  const direct = mcpAppIdSchema.safeParse(appIdOrName)
  if (direct.success) return appId(direct.data)
  const name = mcpAppPublicNameSchema.safeParse(appIdOrName)
  if (!name.success) return null
  const [named] = await db.select({ appId: PublicMcpAppNameTable.configObjectId }).from(PublicMcpAppNameTable)
    .where(eq(PublicMcpAppNameTable.name, name.data)).limit(1)
  const parsed = mcpAppIdSchema.safeParse(named?.appId)
  return parsed.success ? appId(parsed.data) : null
}

export function loadPublicMcpApp(input: { appIdOrName: string }): Promise<McpAppResource | null> {
  return withPrimaryReads(() => loadPublicMcpAppOnPrimary(input))
}

async function loadPublicMcpAppOnPrimary(input: { appIdOrName: string }): Promise<McpAppResource | null> {
  if (!env.appMcpServersEnabled) return null
  const id = await appIdForPublicPath(input.appIdOrName)
  if (!id) return null
  const [app] = await db.select({ organizationId: ConfigObjectTable.organizationId }).from(ConfigObjectTable).where(and(
    eq(ConfigObjectTable.id, id),
    eq(ConfigObjectTable.objectType, "app"),
    eq(ConfigObjectTable.status, "active"),
    isNull(ConfigObjectTable.deletedAt),
  )).limit(1)
  if (!app) return null
  const head = await latestRevisionHead(app.organizationId, id)
  const content = head ? await revisionContent(app.organizationId, id, head) : null
  if (!head || !content) return null
  const { payload } = content
  if (payload.public !== true || payload.tools.length > 0 || payload.storage) return null
  content.intact ??= digest(payload.html) === payload.resourceDigest && Buffer.byteLength(payload.html) === payload.htmlBytes
  if (!content.intact) return null
  return {
    app: summarizeMcpAppRevision({ appId: id, revisionId: head.id, payload }),
    html: payload.html,
    csp: payload.csp,
    resourceDigest: payload.resourceDigest,
  }
}

if (process.env.OPENWORK_MCP_APP_TIMINGS === "1") {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.name.startsWith("openwork.mcp-app.")) {
      console.log("MCP_APP_TIMING", JSON.stringify({ stage: entry.name, durationMs: entry.duration }))
    }
  }).observe({ entryTypes: ["measure"] })
}
