import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { getConnectedAccount } from "../capability-sources/oauth-credentials.js"
import { db } from "../db.js"
import { resolvePluginArchGrantRole } from "../routes/org/plugin-system/access.js"
import { scoreText, tokenize } from "./search.js"
import type { McpMemberIdentity } from "./external-capabilities.js"
import type { CapabilityMatch } from "./search.js"

const MARKETPLACE_CAPABILITY_PREFIX = "plugin:"
const PROVENANCE_SUFFIX = "in your organization's library."

type OrganizationId = DenTypeId<"organization">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">
type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
type ConfigObjectType = ConfigObjectRow["objectType"]
export type MarketplaceCapabilityObjectType = ConfigObjectType
type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
type MemberRow = Pick<typeof MemberTable.$inferSelect, "id" | "role">
type UsableExternalMcpConnection = Awaited<ReturnType<typeof listUsableExternalMcpConnections>>[number]
type MarketplaceCapabilityRow = {
  configObject: ConfigObjectRow
  marketplace: typeof MarketplaceTable.$inferSelect
  plugin: typeof PluginTable.$inferSelect
}
type GrantRow = {
  orgMembershipId: DenTypeId<"member"> | null
  orgWide: boolean
  removedAt: Date | null
  role: "viewer" | "editor" | "manager"
  teamId: DenTypeId<"team"> | null
}
type GrantWithResourceId = GrantRow & { resourceId: string }

export type MarketplaceCapabilityMatch = CapabilityMatch & {
  kind: ConfigObjectType
  plugin: string
  marketplace?: string
  status?: "needs_install" | "content_not_synced"
  hint?: string
}

type MarketplaceCapabilityStatus = "connection_available" | "content_not_synced" | "needs_connection" | "needs_install" | "unsupported"

export type MarketplaceCapabilityExecutePayload = {
  kind: ConfigObjectType
  plugin: string
  marketplace: string
  name: string
  description: string | null
  provenance: string
  content?: string
  definition?: string | null
  serverSpec?: Record<string, unknown>
  source?: string | null
  status?: MarketplaceCapabilityStatus
  hint?: string
}

export type MarketplaceCapabilityExecuteResult =
  | { ok: true; result: MarketplaceCapabilityExecutePayload }
  | { ok: false; error: "unknown_capability" | "forbidden"; message: string }

export type MarketplaceConfigObjectExecutionMode = "desktop_only" | "instructional" | "mcp"

export type MarketplaceCloudReadinessState = "ready" | "needs_signin" | "needs_admin_setup" | "desktop_only" | "not_synced"

export type MarketplaceCloudReadinessConnection = {
  id: string | null
  name: string
  url: string
  credentialMode?: "shared" | "per_member"
  connectedForMe?: boolean
}

export type MarketplacePluginCloudReadiness = {
  state: MarketplaceCloudReadinessState
  hasInstructional: boolean
  connections: MarketplaceCloudReadinessConnection[]
}

type MarketplaceReadinessConfigObject = {
  id: ConfigObjectId
  objectType: ConfigObjectType
  pluginId: PluginId
  title: string
}

type MarketplaceMcpDependency = {
  name: string
  url: string
}

export function buildMarketplaceCapabilityName(pluginId: string, configObjectId: string): string {
  return `${MARKETPLACE_CAPABILITY_PREFIX}${pluginId}:${configObjectId}`
}

export function parseMarketplaceCapabilityName(name: string): { configObjectId: string; pluginId: string } | null {
  if (!name.startsWith(MARKETPLACE_CAPABILITY_PREFIX)) return null
  const rest = name.slice(MARKETPLACE_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex >= rest.length - 1) return null
  return {
    pluginId: rest.slice(0, separatorIndex),
    configObjectId: rest.slice(separatorIndex + 1),
  }
}

function normalizeMarketplaceIds(input: { configObjectId: string; pluginId: string }): { configObjectId: ConfigObjectId; pluginId: PluginId } | null {
  try {
    return {
      configObjectId: normalizeDenTypeId("configObject", input.configObjectId),
      pluginId: normalizeDenTypeId("plugin", input.pluginId),
    }
  } catch {
    return null
  }
}

function roleIncludes(roleValue: string, role: string): boolean {
  return roleValue
    .split(",")
    .map((entry) => entry.trim())
    .includes(role)
}

function isOrgAdmin(member: MemberRow): boolean {
  return roleIncludes(member.role, "owner") || roleIncludes(member.role, "admin")
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function groupGrants<TGrant extends GrantWithResourceId>(rows: TGrant[]): Map<string, TGrant[]> {
  const grouped = new Map<string, TGrant[]>()
  for (const row of rows) {
    const existing = grouped.get(row.resourceId) ?? []
    existing.push(row)
    grouped.set(row.resourceId, existing)
  }
  return grouped
}

function grantRole(member: McpMemberIdentity, grants: GrantRow[]) {
  return resolvePluginArchGrantRole({
    grants,
    memberId: member.orgMembershipId,
    teamIds: member.teamIds,
  })
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || fallback
}

function pluginPath(row: MarketplaceCapabilityRow): string {
  const pluginSlug = slugify(row.plugin.name, row.plugin.id)
  const relativePath = row.configObject.currentRelativePath?.trim()
    || row.configObject.currentFileName?.trim()
    || row.configObject.id
  return `plugin://${pluginSlug}/${relativePath.replace(/^\/+/, "")}`
}

function provenance(pluginName: string): string {
  return `Content from marketplace plugin ${pluginName} ${PROVENANCE_SUFFIX}`
}

function objectHint(row: MarketplaceCapabilityRow): string {
  return `Install marketplace plugin "${row.plugin.name}" from "${row.marketplace.name}" locally to use "${row.configObject.title}".`
}

function contentNotSyncedHint(row: MarketplaceCapabilityRow): string {
  return `Marketplace plugin "${row.plugin.name}" has not synced content for "${row.configObject.title}" yet. Connect or sync the source, then try again.`
}

function summaryFor(row: MarketplaceCapabilityRow): string {
  const prefix = `[${row.marketplace.name} / ${row.plugin.name}] ${row.configObject.title}`
  const description = row.configObject.description?.trim()
  return description ? `${prefix}: ${description}` : prefix
}

function scoreMarketplaceRow(row: MarketplaceCapabilityRow, queryTokens: string[]): number {
  const score = scoreText(
    tokenize(row.configObject.title),
    tokenize(row.configObject.description ?? ""),
    queryTokens,
    tokenize(row.configObject.searchText ?? ""),
  )
  if (row.configObject.objectType !== "skill") return score
  return queryTokens.some((queryToken) => queryToken === "skill" || queryToken === "skills")
    ? score + 1
    : score
}

function basePayload(row: MarketplaceCapabilityRow): MarketplaceCapabilityExecutePayload {
  return {
    kind: row.configObject.objectType,
    plugin: row.plugin.name,
    marketplace: row.marketplace.name,
    name: row.configObject.title,
    description: row.configObject.description,
    provenance: provenance(row.plugin.name),
  }
}

async function getActiveMember(organizationId: OrganizationId, member: McpMemberIdentity | null): Promise<MemberRow | null> {
  if (!member) return null
  const rows = await db
    .select({ id: MemberTable.id, role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.id, member.orgMembershipId),
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  return rows[0] ?? null
}

async function listActiveMarketplaceRows(organizationId: OrganizationId): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      marketplace: MarketplaceTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .innerJoin(
      MarketplacePluginTable,
      eq(MarketplacePluginTable.pluginId, PluginTable.id),
    )
    .innerJoin(
      MarketplaceTable,
      eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId),
    )
    .where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.organizationId, organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(MarketplacePluginTable.organizationId, organizationId),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(PluginTable.name, ConfigObjectTable.title, MarketplaceTable.name)
  return rows
}

async function listActiveMarketplaceRowsForCapability(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<MarketplaceCapabilityRow[]> {
  const rows = await db
    .select({
      configObject: ConfigObjectTable,
      marketplace: MarketplaceTable,
      plugin: PluginTable,
    })
    .from(ConfigObjectTable)
    .innerJoin(
      PluginConfigObjectTable,
      eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id),
    )
    .innerJoin(
      PluginTable,
      eq(PluginTable.id, PluginConfigObjectTable.pluginId),
    )
    .innerJoin(
      MarketplacePluginTable,
      eq(MarketplacePluginTable.pluginId, PluginTable.id),
    )
    .innerJoin(
      MarketplaceTable,
      eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId),
    )
    .where(and(
      eq(ConfigObjectTable.id, input.configObjectId),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.pluginId, input.pluginId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.id, input.pluginId),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(MarketplaceTable.name)
  return rows
}

async function listConfigObjectGrants(organizationId: OrganizationId, configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) return []
  return db
    .select({
      resourceId: ConfigObjectAccessGrantTable.configObjectId,
      orgMembershipId: ConfigObjectAccessGrantTable.orgMembershipId,
      orgWide: ConfigObjectAccessGrantTable.orgWide,
      removedAt: ConfigObjectAccessGrantTable.removedAt,
      role: ConfigObjectAccessGrantTable.role,
      teamId: ConfigObjectAccessGrantTable.teamId,
    })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, organizationId),
      inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
    ))
}

async function listPluginGrants(organizationId: OrganizationId, pluginIds: PluginId[]) {
  if (pluginIds.length === 0) return []
  return db
    .select({
      resourceId: PluginAccessGrantTable.pluginId,
      orgMembershipId: PluginAccessGrantTable.orgMembershipId,
      orgWide: PluginAccessGrantTable.orgWide,
      removedAt: PluginAccessGrantTable.removedAt,
      role: PluginAccessGrantTable.role,
      teamId: PluginAccessGrantTable.teamId,
    })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
    ))
}

async function listMarketplaceGrants(organizationId: OrganizationId, marketplaceIds: DenTypeId<"marketplace">[]) {
  if (marketplaceIds.length === 0) return []
  return db
    .select({
      resourceId: MarketplaceAccessGrantTable.marketplaceId,
      orgMembershipId: MarketplaceAccessGrantTable.orgMembershipId,
      orgWide: MarketplaceAccessGrantTable.orgWide,
      removedAt: MarketplaceAccessGrantTable.removedAt,
      role: MarketplaceAccessGrantTable.role,
      teamId: MarketplaceAccessGrantTable.teamId,
    })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      eq(MarketplaceAccessGrantTable.organizationId, organizationId),
      inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
    ))
}

async function filterVisibleRows(input: {
  member: McpMemberIdentity
  memberRow: MemberRow
  organizationId: OrganizationId
  rows: MarketplaceCapabilityRow[]
}): Promise<MarketplaceCapabilityRow[]> {
  if (isOrgAdmin(input.memberRow)) return input.rows

  const configObjectGrantRows = await listConfigObjectGrants(
    input.organizationId,
    unique(input.rows.map((row) => row.configObject.id)),
  )
  const pluginGrantRows = await listPluginGrants(
    input.organizationId,
    unique(input.rows.map((row) => row.plugin.id)),
  )
  const marketplaceGrantRows = await listMarketplaceGrants(
    input.organizationId,
    unique(input.rows.map((row) => row.marketplace.id)),
  )
  const configObjectGrants = groupGrants(configObjectGrantRows)
  const pluginGrants = groupGrants(pluginGrantRows)
  const marketplaceGrants = groupGrants(marketplaceGrantRows)

  return input.rows.filter((row) => {
    if (grantRole(input.member, configObjectGrants.get(row.configObject.id) ?? [])) return true
    if (grantRole(input.member, pluginGrants.get(row.plugin.id) ?? [])) return true
    return Boolean(grantRole(input.member, marketplaceGrants.get(row.marketplace.id) ?? []))
  })
}

async function latestVersion(configObjectId: ConfigObjectId, organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.configObjectId, configObjectId),
      eq(ConfigObjectVersionTable.organizationId, organizationId),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .limit(1)
  return rows[0] ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null
}

function versionServerSpec(version: ConfigObjectVersionRow): Record<string, unknown> {
  return version.normalizedPayloadJson ?? parseJsonRecord(version.rawSourceText) ?? {}
}

export function marketplaceConfigObjectExecutionMode(objectType: ConfigObjectType): MarketplaceConfigObjectExecutionMode {
  switch (objectType) {
    case "mcp":
      return "mcp"
    case "agent":
    case "command":
    case "context":
    case "custom":
    case "skill":
      return "instructional"
    case "hook":
    case "tool":
      return "desktop_only"
  }
}

export function marketplaceMcpServerEntries(spec: Record<string, unknown>, fallbackName: string): { config: Record<string, unknown>; name: string }[] {
  const entries: { config: Record<string, unknown>; name: string }[] = []
  for (const key of ["mcp", "mcpServers"]) {
    const container = spec[key]
    if (!isRecord(container)) continue
    for (const [name, config] of Object.entries(container)) {
      if (isRecord(config)) entries.push({ name, config })
    }
  }
  if (entries.length === 0 && (readString(spec.url) || readString(spec.command))) {
    entries.push({ name: fallbackName, config: spec })
  }
  return entries
}

export function comparableMarketplaceMcpUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function mcpDependenciesForObject(input: {
  object: MarketplaceReadinessConfigObject
  version: ConfigObjectVersionRow
}): MarketplaceMcpDependency[] {
  const spec = versionServerSpec(input.version)
  const dependencies = marketplaceMcpServerEntries(spec, input.object.title).map((entry) => ({
    name: entry.name,
    url: readString(entry.config.url) ?? "",
  }))
  return dependencies.length > 0 ? dependencies : [{ name: input.object.title, url: "" }]
}

function isSharedConnectionReady(connection: UsableExternalMcpConnection): boolean {
  return Boolean(connection.accessToken || connection.apiKey || (connection.authType === "none" && connection.connectedAt))
}

async function connectedForMember(input: {
  connection: UsableExternalMcpConnection
  member: McpMemberIdentity
}): Promise<boolean> {
  if (input.connection.credentialMode === "shared") return isSharedConnectionReady(input.connection)
  const account = await getConnectedAccount({
    organizationId: input.connection.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    providerId: input.connection.id,
  })
  return Boolean(account?.accessToken)
}

async function resolveMcpReadinessConnections(input: {
  connections: UsableExternalMcpConnection[]
  dependencies: MarketplaceMcpDependency[]
  member: McpMemberIdentity
}): Promise<MarketplaceCloudReadinessConnection[]> {
  const connectedCache = new Map<string, boolean>()
  const output: MarketplaceCloudReadinessConnection[] = []

  for (const dependency of input.dependencies) {
    const comparableDependencyUrl = dependency.url ? comparableMarketplaceMcpUrl(dependency.url) : ""
    const matched = comparableDependencyUrl
      ? input.connections.find((connection) => comparableMarketplaceMcpUrl(connection.url) === comparableDependencyUrl)
      : null
    if (!matched) {
      output.push({ id: null, name: dependency.name, url: dependency.url })
      continue
    }

    let connectedForMe = connectedCache.get(matched.id)
    if (connectedForMe === undefined) {
      connectedForMe = await connectedForMember({ connection: matched, member: input.member })
      connectedCache.set(matched.id, connectedForMe)
    }
    output.push({
      id: matched.id,
      name: matched.name,
      url: matched.url,
      credentialMode: matched.credentialMode,
      connectedForMe,
    })
  }

  return output
}

function groupReadinessObjects(rows: MarketplaceReadinessConfigObject[]) {
  const grouped = new Map<string, MarketplaceReadinessConfigObject[]>()
  for (const row of rows) {
    const existing = grouped.get(row.pluginId) ?? []
    existing.push(row)
    grouped.set(row.pluginId, existing)
  }
  return grouped
}

async function latestVersionsForReadiness(organizationId: OrganizationId, configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) return new Map<string, ConfigObjectVersionRow>()
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, configObjectIds),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const versions = new Map<string, ConfigObjectVersionRow>()
  for (const row of rows) {
    if (!versions.has(row.configObjectId)) versions.set(row.configObjectId, row)
  }
  return versions
}

export async function resolveMarketplacePluginCloudReadiness(input: {
  desktopManifestPluginIds?: PluginId[]
  member: McpMemberIdentity
  organizationId: OrganizationId
  pluginIds: PluginId[]
}): Promise<Map<string, MarketplacePluginCloudReadiness>> {
  const pluginIds = unique(input.pluginIds)
  const readiness = new Map<string, MarketplacePluginCloudReadiness>()
  if (pluginIds.length === 0) return readiness

  const rows = await db
    .select({
      id: ConfigObjectTable.id,
      objectType: ConfigObjectTable.objectType,
      pluginId: PluginConfigObjectTable.pluginId,
      title: ConfigObjectTable.title,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      inArray(PluginConfigObjectTable.pluginId, pluginIds),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))

  const objectsByPluginId = groupReadinessObjects(rows)
  const latestVersions = await latestVersionsForReadiness(input.organizationId, rows.map((row) => row.id))
  const usableConnections = await listUsableExternalMcpConnections({
    organizationId: input.organizationId,
    orgMembershipId: input.member.orgMembershipId,
    teamIds: input.member.teamIds,
  })
  const desktopManifestPluginIds = new Set(input.desktopManifestPluginIds ?? [])

  for (const pluginId of pluginIds) {
    const objects = objectsByPluginId.get(pluginId) ?? []
    if (objects.length === 0) {
      readiness.set(pluginId, {
        state: desktopManifestPluginIds.has(pluginId) ? "desktop_only" : "not_synced",
        hasInstructional: false,
        connections: [],
      })
      continue
    }

    const hasInstructional = objects.some((object) => latestVersions.has(object.id) && marketplaceConfigObjectExecutionMode(object.objectType) === "instructional")
    if (objects.some((object) => !latestVersions.has(object.id))) {
      readiness.set(pluginId, { state: "not_synced", hasInstructional, connections: [] })
      continue
    }

    const mcpObjects = objects.filter((object) => marketplaceConfigObjectExecutionMode(object.objectType) === "mcp")
    if (mcpObjects.length === 0) {
      readiness.set(pluginId, {
        state: hasInstructional ? "ready" : "desktop_only",
        hasInstructional,
        connections: [],
      })
      continue
    }

    const dependencies = mcpObjects.flatMap((object) => {
      const version = latestVersions.get(object.id)
      return version ? mcpDependenciesForObject({ object, version }) : []
    })
    const connections = await resolveMcpReadinessConnections({ connections: usableConnections, dependencies, member: input.member })
    const state = connections.some((connection) => connection.id === null || (connection.credentialMode === "shared" && connection.connectedForMe === false))
      ? "needs_admin_setup"
      : connections.some((connection) => connection.credentialMode === "per_member" && connection.connectedForMe === false)
        ? "needs_signin"
        : "ready"
    readiness.set(pluginId, { state, hasInstructional, connections })
  }

  return readiness
}

async function mcpHint(input: {
  member: McpMemberIdentity
  organizationId: OrganizationId
  row: MarketplaceCapabilityRow
  serverSpec: Record<string, unknown>
}): Promise<{ hint: string; status: "connection_available" | "needs_connection" }> {
  const urls = unique(
    marketplaceMcpServerEntries(input.serverSpec, input.row.configObject.title)
      .flatMap((entry) => {
        const url = readString(entry.config.url)
        return url ? [comparableMarketplaceMcpUrl(url)] : []
      }),
  )
  if (urls.length > 0) {
    const visibleConnections = await listUsableExternalMcpConnections({
      organizationId: input.organizationId,
      orgMembershipId: input.member.orgMembershipId,
      teamIds: input.member.teamIds,
    })
    const matching = visibleConnections.find((connection) => urls.includes(comparableMarketplaceMcpUrl(connection.url)))
    if (matching) {
      return {
        status: "connection_available",
        hint: `An External MCP Connection named "${matching.name}" already points at this server. Search capabilities for "${matching.name}" to use its tools.`,
      }
    }
  }

  return {
    status: "needs_connection",
    hint: `This plugin declares an MCP server but OpenWork will not auto-provision it. Ask an org admin to add it in OpenWork Cloud -> Connections, or install "${input.row.plugin.name}" locally.`,
  }
}

function commandArguments(body: unknown): string {
  if (!isRecord(body)) return ""
  return typeof body.arguments === "string" ? body.arguments : ""
}

export async function searchMarketplaceCapabilities(input: {
  enabled?: boolean
  limit?: number
  member: McpMemberIdentity | null
  objectTypes?: MarketplaceCapabilityObjectType[]
  organizationId: string
  query: string
}): Promise<MarketplaceCapabilityMatch[]> {
  if (input.enabled === false || !input.member) return []
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const memberRow = await getActiveMember(organizationId, input.member)
  if (!memberRow) return []

  const rows = await filterVisibleRows({
    organizationId,
    member: input.member,
    memberRow,
    rows: await listActiveMarketplaceRows(organizationId),
  })
  const matchesByName = new Map<string, MarketplaceCapabilityMatch>()

  for (const row of rows) {
    if (input.objectTypes && !input.objectTypes.includes(row.configObject.objectType)) continue
    const score = scoreMarketplaceRow(row, queryTokens)
    if (score <= 0) continue
    const name = buildMarketplaceCapabilityName(row.plugin.id, row.configObject.id)
    if (matchesByName.has(name)) continue
    const match: MarketplaceCapabilityMatch = {
      name,
      method: "PLUGIN",
      path: pluginPath(row),
      score,
      summary: summaryFor(row),
      pathParams: [],
      queryParams: [],
      hasBody: row.configObject.objectType === "command",
      kind: row.configObject.objectType,
      plugin: row.plugin.name,
      marketplace: row.marketplace.name,
    }
    if (row.configObject.objectType === "tool") {
      match.status = "needs_install"
      match.hint = objectHint(row)
    }
    matchesByName.set(name, match)
  }

  return [...matchesByName.values()]
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .slice(0, input.limit ?? 5)
}

export async function executeMarketplaceCapability(input: {
  body?: unknown
  configObjectId: string
  enabled?: boolean
  member: McpMemberIdentity | null
  organizationId: string
  pluginId: string
}): Promise<MarketplaceCapabilityExecuteResult> {
  if (input.enabled === false) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }
  if (!input.member) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }

  const normalizedIds = normalizeMarketplaceIds({ pluginId: input.pluginId, configObjectId: input.configObjectId })
  if (!normalizedIds) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }

  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const rows = await listActiveMarketplaceRowsForCapability({
    organizationId,
    pluginId: normalizedIds.pluginId,
    configObjectId: normalizedIds.configObjectId,
  })
  if (rows.length === 0) {
    return { ok: false, error: "unknown_capability", message: "No such capability." }
  }

  const memberRow = await getActiveMember(organizationId, input.member)
  if (!memberRow) {
    return { ok: false, error: "forbidden", message: "No active org membership for this token." }
  }
  const visibleRows = await filterVisibleRows({ organizationId, member: input.member, memberRow, rows })
  const row = visibleRows[0]
  if (!row) {
    return { ok: false, error: "forbidden", message: "You have not been granted access to this marketplace plugin capability." }
  }

  const version = await latestVersion(row.configObject.id, organizationId)
  if (!version) {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        status: "content_not_synced",
        hint: contentNotSyncedHint(row),
      },
    }
  }

  if (row.configObject.objectType === "command") {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        content: (version.rawSourceText ?? "").replaceAll("$ARGUMENTS", commandArguments(input.body)),
      },
    }
  }

  if (
    row.configObject.objectType === "skill"
    || row.configObject.objectType === "context"
    || row.configObject.objectType === "custom"
    || row.configObject.objectType === "agent"
  ) {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        content: version.rawSourceText ?? "",
      },
    }
  }

  if (row.configObject.objectType === "mcp") {
    const serverSpec = versionServerSpec(version)
    const guidance = await mcpHint({ organizationId, member: input.member, row, serverSpec })
    return {
      ok: true,
      result: {
        ...basePayload(row),
        serverSpec,
        status: guidance.status,
        hint: guidance.hint,
      },
    }
  }

  if (row.configObject.objectType === "tool") {
    return {
      ok: true,
      result: {
        ...basePayload(row),
        source: version.rawSourceText,
        status: "needs_install",
        hint: objectHint(row),
      },
    }
  }

  return {
    ok: true,
    result: {
      ...basePayload(row),
      definition: version.rawSourceText,
      status: "unsupported",
      hint: "Marketplace plugin hooks are not supported on the OpenWork capability rail yet.",
    },
  }
}
