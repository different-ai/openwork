import { createHash } from "node:crypto"
import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectVersionTable,
  RemoteMcpAppTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "./db.js"
import { createGuardedFetch, createRealmSafeFetch } from "./capability-sources/url-guard.js"
import {
  createConfigObject,
  createConfigObjectVersion,
  createPlugin,
  syncPluginMcpRequirementAccessForResource,
} from "./routes/org/plugin-system/store.js"
import {
  requirePluginArchResourceRole,
  resolvePluginArchResourceRole,
  type PluginArchActorContext,
} from "./routes/org/plugin-system/access.js"

export const REMOTE_MCP_APP_CONFIG_SCHEMA_VERSION = "openwork.remote-mcp-app-installation/1" as const
// Keep imported portable bundles aligned with the desktop MCP Apps host's
// authoritative resources/read ceiling.
export const REMOTE_MCP_APP_MAX_BYTES = 768 * 1024
export const REMOTE_MCP_APP_FETCH_TIMEOUT_MS = 15_000

export const remoteMcpAppDocumentMetadataSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  description: z.string().trim().max(2_000).optional(),
  launchTool: z.object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(1_000).optional(),
  }).strict().optional(),
}).strict()

export type RemoteMcpAppDocumentMetadata = z.infer<typeof remoteMcpAppDocumentMetadataSchema>

type RemoteMcpAppVersionPayload = {
  kind: "remote_mcp_app"
  metadata: RemoteMcpAppDocumentMetadata
  source: {
    url: string
    resolvedUrl: string
    fetchedAt: string
    contentType: string | null
  }
  resource: {
    byteSize: number
    digest: string
    csp: {
      connectDomains: string[]
      resourceDomains: string[]
      frameDomains: string[]
      baseUriDomains: string[]
    }
  }
  diagnostics: string[]
}

type RemoteMcpAppRow = typeof RemoteMcpAppTable.$inferSelect
type RemoteMcpAppVersionRow = typeof ConfigObjectVersionTable.$inferSelect

export class RemoteMcpAppError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RemoteMcpAppError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function readAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"))
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null
}

function documentText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function documentMetadata(html: string, digest: string): RemoteMcpAppDocumentMetadata {
  const title = documentText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title(?:\s[^>]*)?>/i)?.[1] ?? "")
  const descriptionTag = [...html.matchAll(/<meta\b([^>]*)>/gi)].find((match) => (
    readAttribute(match[1] ?? "", "name")?.toLowerCase() === "description"
  ))
  const description = documentText(readAttribute(descriptionTag?.[1] ?? "", "content") ?? "")
  return remoteMcpAppDocumentMetadataSchema.parse({
    name: title || "Cached MCP App",
    version: digest.slice("sha256:".length, "sha256:".length + 12),
    ...(description ? { description } : {}),
    launchTool: {
      title: title ? `Open ${title}` : "Open cached MCP App",
      description: description || "Open the cached self-contained MCP App resource.",
    },
  })
}

function externalResourceReferences(html: string): string[] {
  const findings: string[] = []
  const scriptBodiesRemoved = html.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script(?:\s[^>]*)?>)/gi,
    "$1$2",
  )
  const styleSources = [...scriptBodiesRemoved.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style(?:\s[^>]*)?>/gi)]
    .map((match) => match[1] ?? "")
  const markup = scriptBodiesRemoved.replace(
    /(<style\b[^>]*>)[\s\S]*?(<\/style(?:\s[^>]*)?>)/gi,
    "$1$2",
  )
  const pushTagReference = (tag: string, attributes: string, attribute: string) => {
    const value = readAttribute(attributes, attribute)?.trim()
    if (!value || value.startsWith("data:") || value.startsWith("#")) return
    findings.push(`<${tag}> ${attribute}`)
  }

  for (const match of markup.matchAll(/<(script|img|audio|video|source|iframe|embed)\b([^>]*)>/gi)) {
    const tag = (match[1] ?? "resource").toLowerCase()
    const attributes = match[2] ?? ""
    if (tag === "iframe" || tag === "embed") findings.push(`<${tag}>`)
    pushTagReference(tag, attributes, "src")
    if (tag === "img" || tag === "source") pushTagReference(tag, attributes, "srcset")
    if (tag === "video") pushTagReference(tag, attributes, "poster")
  }
  if (/<frame\b/i.test(markup)) findings.push("<frame>")
  for (const match of markup.matchAll(/<object\b([^>]*)>/gi)) {
    findings.push("<object>")
    pushTagReference("object", match[1] ?? "", "data")
  }
  for (const match of markup.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = match[1] ?? ""
    const rel = readAttribute(attributes, "rel")?.toLowerCase() ?? ""
    if (/(?:stylesheet|preload|modulepreload|icon)/.test(rel)) pushTagReference("link", attributes, "href")
  }
  const inlineStyles = [...markup.matchAll(/<[a-z][^>]*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
  for (const css of [...styleSources, ...inlineStyles]) {
    for (const match of css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)) {
      const value = (match[2] ?? "").trim()
      if (value && !value.startsWith("data:") && !value.startsWith("#")) findings.push("CSS url()")
    }
    if (/@import\s+(?:url\()?\s*["']/i.test(css)) findings.push("CSS @import")
  }
  if (/<base\b/i.test(markup)) findings.push("<base>")
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(markup)) findings.push("embedded CSP")
  return [...new Set(findings)]
}

export function inspectRemoteMcpAppHtml(html: string) {
  if (!/<!doctype\s+html|<html\b/i.test(html)) {
    throw new RemoteMcpAppError(422, "invalid_html", "The downloaded file is not a complete HTML document.")
  }
  const references = externalResourceReferences(html)
  if (references.length > 0) {
    throw new RemoteMcpAppError(
      422,
      "app_not_self_contained",
      `The app must be one self-contained HTML file. Remove external resource references: ${references.join(", ")}.`,
    )
  }
  const digest = sha256(html)
  const metadata = documentMetadata(html, digest)
  return {
    metadata,
    byteSize: Buffer.byteLength(html, "utf8"),
    digest,
    diagnostics: [
      "Self-contained HTML validated.",
      "The cached HTML is exposed through standard MCP tools and resources; no embedded OpenWork runtime manifest is required.",
      "Runtime network, subframes, external resources, and base URI changes are blocked by the host CSP.",
    ],
  }
}

export function validateRemoteMcpAppSourceUrl(rawUrl: string, allowInsecureHttp = false) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new RemoteMcpAppError(400, "invalid_source_url", "Enter a valid HTTPS URL.")
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new RemoteMcpAppError(400, "invalid_source_url", "Remote MCP App URLs must use HTTPS.")
  }
  if (url.hash) throw new RemoteMcpAppError(400, "invalid_source_url", "Remote MCP App URLs must not contain a fragment.")
  if (url.username || url.password) {
    throw new RemoteMcpAppError(400, "invalid_source_url", "Remote MCP App URLs must not contain embedded credentials.")
  }
  const sensitive = new Set(["access_token", "api_key", "client_secret", "token", "refresh_token", "id_token", "code_verifier"])
  for (const key of url.searchParams.keys()) {
    const normalizedKey = key.toLowerCase()
    const looksSensitive = sensitive.has(normalizedKey)
      || ["authorization", "credential", "sig", "signature"].includes(normalizedKey)
      || /(?:^|[_-])(?:auth|credential|secret|signature|token)(?:$|[_-])/.test(normalizedKey)
    if (looksSensitive) {
      throw new RemoteMcpAppError(400, "invalid_source_url", `The source URL query parameter "${key}" must not contain credentials.`)
    }
  }
  return url.toString()
}

export function validateRemoteMcpAppContentType(contentType: string | null) {
  if (!contentType) {
    throw new RemoteMcpAppError(422, "invalid_content_type", "Remote MCP Apps must be served as text/html or application/xhtml+xml.")
  }
  const [rawMimeType, ...parameters] = contentType.split(";")
  const mimeType = rawMimeType?.trim().toLowerCase()
  if (mimeType !== "text/html" && mimeType !== "application/xhtml+xml") {
    throw new RemoteMcpAppError(422, "invalid_content_type", "Remote MCP Apps must be served as text/html or application/xhtml+xml.")
  }
  for (const parameter of parameters) {
    const match = parameter.trim().match(/^charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))$/i)
    const charset = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase()
    if (charset && charset !== "utf-8" && charset !== "utf8") {
      throw new RemoteMcpAppError(422, "invalid_encoding", "Remote MCP Apps must be UTF-8 HTML.")
    }
  }
  return mimeType
}

async function boundedResponseText(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > REMOTE_MCP_APP_MAX_BYTES) {
    await response.body?.cancel()
    throw new RemoteMcpAppError(413, "app_too_large", `Remote MCP Apps must be ${REMOTE_MCP_APP_MAX_BYTES / 1024} KiB or smaller.`)
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > REMOTE_MCP_APP_MAX_BYTES) {
        await reader.cancel()
        throw new RemoteMcpAppError(413, "app_too_large", `Remote MCP Apps must be ${REMOTE_MCP_APP_MAX_BYTES / 1024} KiB or smaller.`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    // Preserve a leading UTF-8 BOM as U+FEFF so encoding the stored string
    // reproduces the exact downloaded bytes and therefore the stored digest.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new RemoteMcpAppError(422, "invalid_encoding", "Remote MCP Apps must be UTF-8 HTML.")
  }
}

export async function fetchRemoteMcpApp(sourceUrl: string) {
  const { env } = await import("./env.js")
  const normalizedUrl = validateRemoteMcpAppSourceUrl(sourceUrl, env.allowPrivateMcpUrls)
  const guardedFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  let response: Response
  try {
    response = await guardedFetch(normalizedUrl, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5" },
      signal: AbortSignal.timeout(REMOTE_MCP_APP_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof RemoteMcpAppError) throw error
    throw new RemoteMcpAppError(502, "source_fetch_failed", error instanceof Error ? error.message : "The app URL could not be downloaded.")
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new RemoteMcpAppError(502, "source_fetch_failed", `The app URL returned HTTP ${response.status}.`)
  }
  const contentType = response.headers.get("content-type")
  try {
    validateRemoteMcpAppContentType(contentType)
  } catch (error) {
    await response.body?.cancel()
    throw error
  }
  const html = await boundedResponseText(response)
  const inspected = inspectRemoteMcpAppHtml(html)
  const resolvedSourceUrl = validateRemoteMcpAppSourceUrl(response.url || normalizedUrl, env.allowPrivateMcpUrls)
  return {
    ...inspected,
    html,
    sourceUrl: normalizedUrl,
    resolvedSourceUrl,
    contentType,
    fetchedAt: new Date().toISOString(),
  }
}

function payloadForFetchedApp(fetched: Awaited<ReturnType<typeof fetchRemoteMcpApp>>): RemoteMcpAppVersionPayload {
  return {
    kind: "remote_mcp_app",
    metadata: fetched.metadata,
    source: {
      url: fetched.sourceUrl,
      resolvedUrl: fetched.resolvedSourceUrl,
      fetchedAt: fetched.fetchedAt,
      contentType: fetched.contentType,
    },
    resource: {
      byteSize: fetched.byteSize,
      digest: fetched.digest,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    },
    diagnostics: fetched.diagnostics,
  }
}

function parseVersionPayload(row: Pick<RemoteMcpAppVersionRow, "normalizedPayloadJson">): RemoteMcpAppVersionPayload {
  const value = row.normalizedPayloadJson
  if (!isRecord(value) || value.kind !== "remote_mcp_app") {
    throw new RemoteMcpAppError(422, "invalid_cached_app", "The cached app revision metadata is invalid.")
  }
  const metadata = remoteMcpAppDocumentMetadataSchema.safeParse(value.metadata)
  const source = isRecord(value.source) ? value.source : null
  const resource = isRecord(value.resource) ? value.resource : null
  if (!metadata.success || !source || !resource
    || typeof source.url !== "string" || typeof source.resolvedUrl !== "string" || typeof source.fetchedAt !== "string"
    || (source.contentType !== null && typeof source.contentType !== "string")
    || typeof resource.byteSize !== "number" || typeof resource.digest !== "string") {
    throw new RemoteMcpAppError(422, "invalid_cached_app", "The cached app revision metadata is invalid.")
  }
  return value as RemoteMcpAppVersionPayload
}

async function getAppRow(context: PluginArchActorContext, configObjectId: string, role: "viewer" | "editor" | "manager" = "viewer") {
  let id: DenTypeId<"configObject">
  try {
    id = normalizeDenTypeId("configObject", configObjectId)
  } catch {
    throw new RemoteMcpAppError(404, "remote_app_not_found", "Remote MCP App not found.")
  }
  const rows = await db
    .select()
    .from(RemoteMcpAppTable)
    .where(and(eq(RemoteMcpAppTable.organizationId, context.organizationContext.organization.id), eq(RemoteMcpAppTable.configObjectId, id)))
    .limit(1)
  const app = rows[0]
  if (!app) throw new RemoteMcpAppError(404, "remote_app_not_found", "Remote MCP App not found.")
  await requirePluginArchResourceRole({ context, resourceId: app.configObjectId, resourceKind: "config_object", role })
  return app
}

function serializeRevision(row: RemoteMcpAppVersionRow, activeVersionId: string | null) {
  const payload = parseVersionPayload(row)
  return {
    id: row.id,
    active: row.id === activeVersionId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    metadata: payload.metadata,
    source: payload.source,
    resource: payload.resource,
    diagnostics: payload.diagnostics,
    resourceUri: remoteMcpAppResourceUri(row.configObjectId, row.id),
  }
}

async function serializeApp(app: RemoteMcpAppRow, role: "viewer" | "editor" | "manager") {
  const versions = await db.select().from(ConfigObjectVersionTable)
    .where(and(eq(ConfigObjectVersionTable.configObjectId, app.configObjectId), eq(ConfigObjectVersionTable.isDeletedVersion, false)))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const revisions = versions.map((version) => serializeRevision(version, app.activeVersionId))
  const activeRevision = revisions.find((revision) => revision.active) ?? null
  const latestRevision = revisions[0] ?? null
  return {
    id: app.configObjectId,
    pluginId: app.pluginId,
    status: app.status,
    sourceUrl: app.sourceUrl,
    resolvedSourceUrl: app.resolvedSourceUrl,
    activeVersionId: app.activeVersionId,
    activeRevision,
    latestRevision,
    revisions,
    role,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    retiredAt: app.retiredAt?.toISOString() ?? null,
  }
}

export function remoteMcpAppResourceUri(configObjectId: string, versionId: string) {
  return `ui://openwork/library-apps/${configObjectId}/revisions/${versionId}/index.html`
}

export async function previewRemoteMcpApp(sourceUrl: string) {
  const fetched = await fetchRemoteMcpApp(sourceUrl)
  return {
    metadata: fetched.metadata,
    sourceUrl: fetched.sourceUrl,
    resolvedSourceUrl: fetched.resolvedSourceUrl,
    resource: {
      byteSize: fetched.byteSize,
      digest: fetched.digest,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    },
    diagnostics: fetched.diagnostics,
  }
}

export async function importRemoteMcpApp(input: {
  context: PluginArchActorContext
  pluginId?: string
  sourceUrl: string
  activate?: boolean
}) {
  let pluginId: DenTypeId<"plugin"> | null = null
  if (input.pluginId) {
    try {
      pluginId = normalizeDenTypeId("plugin", input.pluginId)
    } catch {
      throw new RemoteMcpAppError(404, "plugin_not_found", "Plugin not found.")
    }
    // Reject an unavailable target before performing any outbound download.
    await requirePluginArchResourceRole({
      context: input.context,
      resourceId: pluginId,
      resourceKind: "plugin",
      role: "editor",
    })
  }
  const fetched = await fetchRemoteMcpApp(input.sourceUrl)
  if (!pluginId) {
    const plugin = await createPlugin({
      context: input.context,
      name: fetched.metadata.name,
      description: fetched.metadata.description,
      sourceRepositoryUrl: fetched.sourceUrl.length <= 1024 ? fetched.sourceUrl : null,
    })
    pluginId = normalizeDenTypeId("plugin", plugin.id)
  }
  const configObject = await createConfigObject({
    context: input.context,
    objectType: "app",
    pluginIds: [pluginId],
    sourceMode: "import",
    value: {
      normalizedPayloadJson: payloadForFetchedApp(fetched) as unknown as Record<string, unknown>,
      rawSourceText: fetched.html,
      schemaVersion: REMOTE_MCP_APP_CONFIG_SCHEMA_VERSION,
    },
  })
  const versionId = configObject.latestVersion?.id
  if (!versionId) throw new RemoteMcpAppError(422, "app_import_incomplete", "The immutable app revision was not created.")
  const now = new Date()
  const app: RemoteMcpAppRow = {
    configObjectId: normalizeDenTypeId("configObject", configObject.id),
    organizationId: input.context.organizationContext.organization.id,
    pluginId,
    activeVersionId: input.activate === false ? null : normalizeDenTypeId("configObjectVersion", versionId),
    sourceUrl: fetched.sourceUrl,
    resolvedSourceUrl: fetched.resolvedSourceUrl,
    status: "active",
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
  }
  await db.insert(RemoteMcpAppTable).values(app)
  return serializeApp(app, "manager")
}

export async function getRemoteMcpApp(input: { context: PluginArchActorContext; configObjectId: string }) {
  const app = await getAppRow(input.context, input.configObjectId)
  const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: app.configObjectId, resourceKind: "config_object" })
  if (!role) throw new RemoteMcpAppError(404, "remote_app_not_found", "Remote MCP App not found.")
  return serializeApp(app, role)
}

export async function refreshRemoteMcpApp(input: {
  context: PluginArchActorContext
  configObjectId: string
  sourceUrl?: string
}) {
  const app = await getAppRow(input.context, input.configObjectId, "editor")
  if (!app.activeVersionId) throw new RemoteMcpAppError(409, "app_has_no_active_revision", "Activate an app revision before caching an update.")
  const activeVersions = await db.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.configObjectId, app.configObjectId),
    eq(ConfigObjectVersionTable.id, app.activeVersionId),
    eq(ConfigObjectVersionTable.isDeletedVersion, false),
  )).limit(1)
  if (!activeVersions[0]) throw new RemoteMcpAppError(404, "app_revision_not_found", "The active app revision was not found.")
  const fetched = await fetchRemoteMcpApp(input.sourceUrl ?? app.sourceUrl)
  await createConfigObjectVersion({
    context: input.context,
    configObjectId: app.configObjectId,
    reason: fetched.digest,
    value: {
      normalizedPayloadJson: payloadForFetchedApp(fetched) as unknown as Record<string, unknown>,
      rawSourceText: fetched.html,
      schemaVersion: REMOTE_MCP_APP_CONFIG_SCHEMA_VERSION,
    },
  })
  const updatedAt = new Date()
  await db.update(RemoteMcpAppTable).set({
    sourceUrl: fetched.sourceUrl,
    resolvedSourceUrl: fetched.resolvedSourceUrl,
    updatedAt,
  }).where(eq(RemoteMcpAppTable.configObjectId, app.configObjectId))
  const updated = { ...app, sourceUrl: fetched.sourceUrl, resolvedSourceUrl: fetched.resolvedSourceUrl, updatedAt }
  return serializeApp(updated, "editor")
}

export async function activateRemoteMcpAppRevision(input: {
  context: PluginArchActorContext
  configObjectId: string
  versionId: string
}) {
  const app = await getAppRow(input.context, input.configObjectId, "editor")
  if (app.status === "retired") {
    throw new RemoteMcpAppError(409, "app_retired", "Restore this app before activating a revision.")
  }
  let versionId: DenTypeId<"configObjectVersion">
  try {
    versionId = normalizeDenTypeId("configObjectVersion", input.versionId)
  } catch {
    throw new RemoteMcpAppError(404, "app_revision_not_found", "App revision not found.")
  }
  const versions = await db.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.configObjectId, app.configObjectId),
    eq(ConfigObjectVersionTable.id, versionId),
    eq(ConfigObjectVersionTable.isDeletedVersion, false),
  )).limit(1)
  const version = versions[0]
  if (!version || !version.rawSourceText) throw new RemoteMcpAppError(404, "app_revision_not_found", "App revision not found.")
  const payload = parseVersionPayload(version)
  if (sha256(version.rawSourceText) !== payload.resource.digest) {
    throw new RemoteMcpAppError(422, "cached_app_digest_mismatch", "The cached app revision failed its integrity check.")
  }
  const updatedAt = new Date()
  await db.update(RemoteMcpAppTable).set({ activeVersionId: versionId, status: "active", retiredAt: null, updatedAt })
    .where(eq(RemoteMcpAppTable.configObjectId, app.configObjectId))
  return serializeApp({ ...app, activeVersionId: versionId, status: "active", retiredAt: null, updatedAt }, "editor")
}

export async function setRemoteMcpAppRetired(input: {
  context: PluginArchActorContext
  configObjectId: string
  retired: boolean
}) {
  const app = await getAppRow(input.context, input.configObjectId, "manager")
  if (!input.retired) {
    if (!app.activeVersionId) {
      throw new RemoteMcpAppError(409, "app_has_no_active_revision", "Activate an app revision before restoring it.")
    }
    const updatedAt = new Date()
    await db.update(RemoteMcpAppTable).set({ status: "active", retiredAt: null, updatedAt })
      .where(eq(RemoteMcpAppTable.configObjectId, app.configObjectId))
    await syncPluginMcpRequirementAccessForResource({
      context: input.context,
      resourceId: app.configObjectId,
      resourceKind: "config_object",
    })
    try {
      await activateRemoteMcpAppRevision({
        context: input.context,
        configObjectId: app.configObjectId,
        versionId: app.activeVersionId,
      })
      const restored = await getAppRow(input.context, app.configObjectId, "manager")
      return serializeApp(restored, "manager")
    } catch (error) {
      await db.update(RemoteMcpAppTable).set({ status: "retired", retiredAt: app.retiredAt ?? updatedAt, updatedAt })
        .where(eq(RemoteMcpAppTable.configObjectId, app.configObjectId))
      await syncPluginMcpRequirementAccessForResource({
        context: input.context,
        resourceId: app.configObjectId,
        resourceKind: "config_object",
      })
      throw error
    }
  }
  const updatedAt = new Date()
  const retiredAt = updatedAt
  const status = "retired" as const
  await db.update(RemoteMcpAppTable).set({ status, retiredAt, updatedAt })
    .where(eq(RemoteMcpAppTable.configObjectId, app.configObjectId))
  await syncPluginMcpRequirementAccessForResource({
    context: input.context,
    resourceId: app.configObjectId,
    resourceKind: "config_object",
  })
  return serializeApp({ ...app, status, retiredAt, updatedAt }, "manager")
}

export async function loadRemoteMcpAppRevision(input: {
  context: PluginArchActorContext
  configObjectId: string
  versionId: string
}) {
  const app = await getAppRow(input.context, input.configObjectId)
  let versionId: DenTypeId<"configObjectVersion">
  try {
    versionId = normalizeDenTypeId("configObjectVersion", input.versionId)
  } catch {
    throw new RemoteMcpAppError(404, "app_revision_not_found", "App revision not found.")
  }
  const rows = await db.select().from(ConfigObjectVersionTable).where(and(
    eq(ConfigObjectVersionTable.configObjectId, app.configObjectId),
    eq(ConfigObjectVersionTable.id, versionId),
    eq(ConfigObjectVersionTable.isDeletedVersion, false),
  )).limit(1)
  const row = rows[0]
  if (!row?.rawSourceText) throw new RemoteMcpAppError(404, "app_revision_not_found", "App revision not found.")
  const payload = parseVersionPayload(row)
  if (sha256(row.rawSourceText) !== payload.resource.digest) {
    throw new RemoteMcpAppError(422, "cached_app_digest_mismatch", "The cached app revision failed its integrity check.")
  }
  return { app, html: row.rawSourceText, payload, revision: serializeRevision(row, app.activeVersionId) }
}

export async function listActiveRemoteMcpApps(input: { context: PluginArchActorContext }) {
  const rows = await db.select().from(RemoteMcpAppTable).where(and(
    eq(RemoteMcpAppTable.organizationId, input.context.organizationContext.organization.id),
    eq(RemoteMcpAppTable.status, "active"),
  )).orderBy(desc(RemoteMcpAppTable.updatedAt)).limit(100)
  const visible: Array<{
    app: RemoteMcpAppRow
    payload: RemoteMcpAppVersionPayload
    resourceUri: string
    versionId: DenTypeId<"configObjectVersion">
    revisions: Array<{
      payload: RemoteMcpAppVersionPayload
      resourceUri: string
      versionId: DenTypeId<"configObjectVersion">
    }>
  }> = []
  for (const app of rows) {
    if (!app.activeVersionId) continue
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: app.configObjectId, resourceKind: "config_object" })
    if (!role) continue
    const versions = await db.select({
      id: ConfigObjectVersionTable.id,
      normalizedPayloadJson: ConfigObjectVersionTable.normalizedPayloadJson,
    }).from(ConfigObjectVersionTable).where(and(
      eq(ConfigObjectVersionTable.configObjectId, app.configObjectId),
      eq(ConfigObjectVersionTable.isDeletedVersion, false),
    )).orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    const revisions = versions.flatMap((version) => {
      const payload = parseVersionPayload(version)
      return [{
        payload,
        resourceUri: remoteMcpAppResourceUri(app.configObjectId, version.id),
        versionId: version.id,
      }]
    })
    const activeRevision = revisions.find((revision) => revision.versionId === app.activeVersionId)
    if (!activeRevision) continue
    visible.push({
      app,
      ...activeRevision,
      revisions,
    })
  }
  return visible
}
