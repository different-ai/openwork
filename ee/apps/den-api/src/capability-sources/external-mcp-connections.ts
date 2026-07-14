import { and, desc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  OrgOAuthClientTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

/**
 * CRUD for ExternalMcpConnectionTable and its access grants — the "add any
 * MCP server" concept. This is the only module that touches these tables
 * directly; the connector (external-mcp-client.ts) and routes go through
 * these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type ExternalMcpConnectionAccessGrantRow = typeof ExternalMcpConnectionAccessGrantTable.$inferSelect

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">
type PluginMcpRequirementBindingId = DenTypeId<"pluginMcpRequirementBinding">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">

function unique<TValue extends string>(values: TValue[]): TValue[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
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

function versionServerSpec(version: typeof ConfigObjectVersionTable.$inferSelect): Record<string, unknown> {
  return version.normalizedPayloadJson ?? parseJsonRecord(version.rawSourceText) ?? {}
}

function marketplaceMcpServerEntries(spec: Record<string, unknown>, fallbackName: string): { config: Record<string, unknown>; name: string }[] {
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

function comparablePluginMcpRequirementUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.hash = ""
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, "")
  }
}

async function latestConfigObjectVersions(input: {
  configObjectIds: ConfigObjectId[]
  organizationId: OrganizationId
}) {
  if (input.configObjectIds.length === 0) return new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, input.organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, input.configObjectIds),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const versions = new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  for (const row of rows) {
    if (!versions.has(row.configObjectId)) versions.set(row.configObjectId, row)
  }
  return versions
}

function grantFilter(input: { orgMembershipId: OrgMembershipId; teamIds: TeamId[] }) {
  return input.teamIds.length > 0
    ? or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(ExternalMcpConnectionAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )
}

async function directlyUsableExternalMcpConnections(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}) {
  const rows = await db
    .selectDistinct({ connection: ExternalMcpConnectionTable })
    .from(ExternalMcpConnectionTable)
    .innerJoin(
      ExternalMcpConnectionAccessGrantTable,
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
    )
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      grantFilter(input),
    ))
  return rows.map((row) => row.connection)
}

function resourceGrantFilters(input: { orgMembershipId: OrgMembershipId; teamIds: TeamId[] }) {
  const configObjectAccess = input.teamIds.length > 0
    ? or(
        eq(ConfigObjectAccessGrantTable.orgWide, true),
        eq(ConfigObjectAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(ConfigObjectAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(ConfigObjectAccessGrantTable.orgWide, true),
        eq(ConfigObjectAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )
  const pluginAccess = input.teamIds.length > 0
    ? or(
        eq(PluginAccessGrantTable.orgWide, true),
        eq(PluginAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(PluginAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(PluginAccessGrantTable.orgWide, true),
        eq(PluginAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )
  const marketplaceAccess = input.teamIds.length > 0
    ? or(
        eq(MarketplaceAccessGrantTable.orgWide, true),
        eq(MarketplaceAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(MarketplaceAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(MarketplaceAccessGrantTable.orgWide, true),
        eq(MarketplaceAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )
  return { configObjectAccess, pluginAccess, marketplaceAccess }
}

async function accessiblePluginMcpBindingKeys(input: {
  bindings: Array<{ configObjectId: ConfigObjectId; id: PluginMcpRequirementBindingId; pluginId: PluginId }>
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}) {
  const configObjectIds = unique(input.bindings.map((binding) => binding.configObjectId))
  const pluginIds = unique(input.bindings.map((binding) => binding.pluginId))
  const filters = resourceGrantFilters(input)
  const configObjectGrantRows = configObjectIds.length === 0
    ? []
    : await db
      .select({ configObjectId: ConfigObjectAccessGrantTable.configObjectId })
      .from(ConfigObjectAccessGrantTable)
      .where(and(
        eq(ConfigObjectAccessGrantTable.organizationId, input.organizationId),
        inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
        isNull(ConfigObjectAccessGrantTable.removedAt),
        filters.configObjectAccess,
      ))
  const pluginGrantRows = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginAccessGrantTable.pluginId })
      .from(PluginAccessGrantTable)
      .where(and(
        eq(PluginAccessGrantTable.organizationId, input.organizationId),
        inArray(PluginAccessGrantTable.pluginId, pluginIds),
        isNull(PluginAccessGrantTable.removedAt),
        filters.pluginAccess,
      ))
  const marketplaceMembershipRows = pluginIds.length === 0
    ? []
    : await db
      .select({ marketplaceId: MarketplacePluginTable.marketplaceId, pluginId: MarketplacePluginTable.pluginId })
      .from(MarketplacePluginTable)
      .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
      .where(and(
        eq(MarketplacePluginTable.organizationId, input.organizationId),
        inArray(MarketplacePluginTable.pluginId, pluginIds),
        isNull(MarketplacePluginTable.removedAt),
        eq(MarketplaceTable.organizationId, input.organizationId),
        eq(MarketplaceTable.status, "active"),
        isNull(MarketplaceTable.deletedAt),
      ))
  const marketplaceIds = unique(marketplaceMembershipRows.map((row) => row.marketplaceId))
  const marketplaceGrantRows = marketplaceIds.length === 0
    ? []
    : await db
      .select({ marketplaceId: MarketplaceAccessGrantTable.marketplaceId })
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.organizationId, input.organizationId),
        inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
        isNull(MarketplaceAccessGrantTable.removedAt),
        filters.marketplaceAccess,
      ))
  const accessibleConfigObjectIds = new Set(configObjectGrantRows.map((row) => row.configObjectId))
  const accessiblePluginIds = new Set(pluginGrantRows.map((row) => row.pluginId))
  const accessibleMarketplaceIds = new Set(marketplaceGrantRows.map((row) => row.marketplaceId))
  const marketplaceAccessiblePluginIds = new Set(
    marketplaceMembershipRows.flatMap((row) => accessibleMarketplaceIds.has(row.marketplaceId) ? [row.pluginId] : []),
  )

  const bindingIds = new Set<PluginMcpRequirementBindingId>()
  for (const binding of input.bindings) {
    if (
      accessibleConfigObjectIds.has(binding.configObjectId)
      || accessiblePluginIds.has(binding.pluginId)
      || marketplaceAccessiblePluginIds.has(binding.pluginId)
    ) {
      bindingIds.add(binding.id)
    }
  }
  return bindingIds
}

async function sourcedUsableExternalMcpConnections(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}) {
  const rows = await db
    .selectDistinct({
      binding: PluginMcpRequirementBindingTable,
      configObjectTitle: ConfigObjectTable.title,
      connection: ExternalMcpConnectionTable,
    })
    .from(ExternalMcpConnectionTable)
    .innerJoin(
      ExternalMcpConnectionAccessGrantTable,
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
    )
    .innerJoin(
      PluginMcpRequirementBindingTable,
      and(
        eq(PluginMcpRequirementBindingTable.id, ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
        eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId),
      ),
    )
    .innerJoin(PluginTable, eq(PluginTable.id, PluginMcpRequirementBindingTable.pluginId))
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginMcpRequirementBindingTable.configObjectId))
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.pluginId, PluginMcpRequirementBindingTable.pluginId),
      eq(PluginConfigObjectTable.configObjectId, PluginMcpRequirementBindingTable.configObjectId),
    ))
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      grantFilter(input),
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      isNull(PluginConfigObjectTable.removedAt),
    ))
  if (rows.length === 0) return []

  const versions = await latestConfigObjectVersions({
    configObjectIds: unique(rows.map((row) => row.binding.configObjectId)),
    organizationId: input.organizationId,
  })
  const accessibleBindingIds = await accessiblePluginMcpBindingKeys({
    bindings: rows.map((row) => ({
      configObjectId: row.binding.configObjectId,
      id: row.binding.id,
      pluginId: row.binding.pluginId,
    })),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds,
  })

  return rows.flatMap((row) => {
    if (!accessibleBindingIds.has(row.binding.id)) return []
    const version = versions.get(row.binding.configObjectId)
    if (!version) return []
    const entry = marketplaceMcpServerEntries(versionServerSpec(version), row.configObjectTitle)
      .find((candidate) => candidate.name === row.binding.serverName)
    const declaredUrl = readString(entry?.config.url)
    if (!declaredUrl) return []
    return comparablePluginMcpRequirementUrl(row.connection.url) === comparablePluginMcpRequirementUrl(declaredUrl)
      ? [row.connection]
      : []
  })
}

export async function listExternalMcpConnections(organizationId: OrganizationId): Promise<ExternalMcpConnectionRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
}

export async function getExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConnectionRow | null> {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      eq(ExternalMcpConnectionTable.id, input.connectionId),
    ))
    .limit(1)
  return rows[0] ?? null
}

export type ExternalMcpAccessInput = {
  orgWide: boolean
  memberIds: OrgMembershipId[]
  teamIds: TeamId[]
}

export async function createExternalMcpConnection(input: {
  organizationId: OrganizationId
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string | null
  createdByOrgMembershipId: OrgMembershipId
  access: ExternalMcpAccessInput
}): Promise<ExternalMcpConnectionRow> {
  const id = createDenTypeId("externalMcpConnection")
  await db.insert(ExternalMcpConnectionTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  await replaceExternalMcpConnectionAccess({
    organizationId: input.organizationId,
    connectionId: id,
    access: input.access,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  const created = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId: id })
  if (!created) throw new Error("Failed to create external MCP connection.")
  return created
}

export async function listExternalMcpConnectionAccess(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId))
}

async function listDirectExternalMcpConnectionAccess(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId),
      isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
    ))
}

function accessGrantRows(input: {
  access: ExternalMcpAccessInput
  bindingId?: PluginMcpRequirementBindingId
  connectionId: ExternalMcpConnectionId
  createdByOrgMembershipId: OrgMembershipId
  organizationId: OrganizationId
}) {
  const rows: (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] = []
  const sourceKey = input.bindingId ?? "direct"
  if (input.access.orgWide) {
    rows.push({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      pluginMcpRequirementBindingId: input.bindingId ?? null,
      sourceKey,
      orgWide: true,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
    return rows
  }

  for (const memberId of new Set(input.access.memberIds)) {
    rows.push({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      pluginMcpRequirementBindingId: input.bindingId ?? null,
      sourceKey,
      orgMembershipId: memberId,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
  }
  for (const teamId of new Set(input.access.teamIds)) {
    rows.push({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      pluginMcpRequirementBindingId: input.bindingId ?? null,
      sourceKey,
      teamId,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
  }
  return rows
}

/** Full-replace semantics (mirrors the LLM-provider access pattern): the caller sends the complete desired access set. */
export async function replaceExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db
    .delete(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
      isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
    ))

  const rows = accessGrantRows(input)
  if (rows.length > 0) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  }
}

export async function replaceExternalMcpConnectionAccessForPluginBinding(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  bindingId: PluginMcpRequirementBindingId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db
    .delete(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, input.bindingId))

  const rows = accessGrantRows(input)
  if (rows.length > 0) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  }
}

export async function mergeExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  const existing = await listDirectExternalMcpConnectionAccess(input.connectionId)
  const rows: (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] = []

  if (input.access.orgWide) {
    if (!existing.some((grant) => grant.orgWide)) {
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        orgWide: true,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
  } else {
    const existingMemberIds = new Set(existing.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []))
    const existingTeamIds = new Set(existing.flatMap((grant) => grant.teamId ? [grant.teamId] : []))
    for (const memberId of new Set(input.access.memberIds)) {
      if (existingMemberIds.has(memberId)) continue
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        orgMembershipId: memberId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
    for (const teamId of new Set(input.access.teamIds)) {
      if (existingTeamIds.has(teamId)) continue
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        teamId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
  }

  if (rows.length > 0) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  }
}

/**
 * The one access predicate: a member can USE a connection when a grant is
 * org-wide, names them directly, or names one of their teams. Access is
 * never implicit — zero grants means zero non-admin access.
 */
export async function listUsableExternalMcpConnections(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<ExternalMcpConnectionRow[]> {
  const directConnections = await directlyUsableExternalMcpConnections(input)
  const sourcedConnections = await sourcedUsableExternalMcpConnections(input)
  const byId = new Map<string, ExternalMcpConnectionRow>()
  for (const connection of directConnections) byId.set(connection.id, connection)
  for (const connection of sourcedConnections) byId.set(connection.id, connection)
  return [...byId.values()]
}

export async function memberCanUseExternalMcpConnection(input: {
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<boolean> {
  const rows = await db
    .select({ organizationId: ExternalMcpConnectionTable.organizationId })
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
    .limit(1)
  const connection = rows[0]
  if (!connection) return false
  const usable = await listUsableExternalMcpConnections({
    organizationId: connection.organizationId,
    orgMembershipId: input.orgMembershipId,
    teamIds: input.teamIds,
  })
  return usable.some((row) => row.id === input.connectionId)
}

export async function deleteExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (!existing) return false
    // The enterprise adapter takes the same connection-row lock before any
    // credential commit. Deletion and credential persistence therefore have
    // one deterministic winner; a completed delete cannot be followed by a
    // late token write or orphaned account/client row.
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, existing.id),
    )
    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx.delete(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, input.organizationId),
      eq(OrgOAuthClientTable.providerId, existing.id),
    ))
    await tx.delete(PluginMcpRequirementBindingTable).where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, existing.id),
    ))
    await tx.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, existing.id))
    return true
  })
}

export async function saveExternalMcpPendingCodeVerifier(input: {
  connectionId: ExternalMcpConnectionId
  codeVerifier: string | null
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ pendingCodeVerifier: input.codeVerifier })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function markExternalMcpConnectionConnected(connectionId: ExternalMcpConnectionId): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ connectedAt: new Date() })
    .where(eq(ExternalMcpConnectionTable.id, connectionId))
}

export async function clearExternalMcpTokens(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const existing = await getExternalMcpConnection(input)
  if (!existing) return false
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      scope: null,
      expiresAt: null,
      connectedAt: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}

export async function saveExternalMcpTokens(input: {
  connectionId: ExternalMcpConnectionId
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: input.accessToken,
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      pendingCodeVerifier: null,
      connectedAt: new Date(),
    })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function disconnectExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const existing = await getExternalMcpConnection(input)
  if (!existing) return false
  await clearExternalMcpTokens(input)
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      pendingCodeVerifier: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}
