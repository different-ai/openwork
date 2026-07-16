import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, desc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  type ExternalMcpOAuthConfiguration,
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
import { declaredPluginMcpAuthType, requiredPluginMcpAuthType } from "./external-mcp-auth-policy.js"
import { normalizeConnectedAccountScopes, normalizeOAuthClientExtra } from "./oauth-credentials.js"

/**
 * CRUD for ExternalMcpConnectionTable and its access grants — the "add any
 * MCP server" concept. This is the only module that touches these tables
 * directly; the connector (external-mcp-client.ts) and routes go through
 * these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type ExternalMcpConnectionAccessGrantRow = typeof ExternalMcpConnectionAccessGrantTable.$inferSelect
export type ActiveExternalMcpConnectionBinding = {
  connectionId: DenTypeId<"externalMcpConnection">
  pluginId: DenTypeId<"plugin">
  pluginName: string
}

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">
type PluginMcpRequirementBindingId = DenTypeId<"pluginMcpRequirementBinding">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">
type ExternalMcpOAuthConfigurationInput = Omit<ExternalMcpOAuthConfiguration, "callbackMode"> & {
  callbackMode?: ExternalMcpOAuthConfiguration["callbackMode"]
}

function unique<TValue extends string>(values: TValue[]): TValue[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSdkRegisteredOAuthClient(extra: Record<string, unknown> | null): boolean {
  const source = extra?.enterpriseMcpRegistrationSource
  return source === "dynamic"
    || source === "client-metadata"
    || (source === undefined && isRecord(extra?.clientInformation))
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

export function normalizeExternalMcpIdentityUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.hash = ""
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, "")
  }
}

/** A non-secret, one-way binding for OAuth state minted for this identity. */
export function externalMcpIdentityBinding(
  connection: Pick<ExternalMcpConnectionRow, "url" | "authType" | "credentialMode">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      normalizeExternalMcpIdentityUrl(connection.url),
      connection.authType,
      connection.credentialMode,
    ]))
    .digest("base64url")
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
    const requiredAuthType = entry
      ? requiredPluginMcpAuthType({ declaredAuthType: declaredPluginMcpAuthType(entry.config), url: declaredUrl })
      : null
    if (requiredAuthType && row.connection.authType !== requiredAuthType) return []
    return normalizeExternalMcpIdentityUrl(row.connection.url) === normalizeExternalMcpIdentityUrl(declaredUrl)
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

export async function listActiveExternalMcpConnectionBindings(input: {
  organizationId: OrganizationId
  connectionIds: ExternalMcpConnectionId[]
}): Promise<ActiveExternalMcpConnectionBinding[]> {
  if (input.connectionIds.length === 0) return []
  return db
    .select({
      connectionId: PluginMcpRequirementBindingTable.externalMcpConnectionId,
      pluginId: PluginTable.id,
      pluginName: PluginTable.name,
    })
    .from(PluginMcpRequirementBindingTable)
    .innerJoin(PluginTable, eq(PluginMcpRequirementBindingTable.pluginId, PluginTable.id))
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      inArray(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connectionIds),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
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
  oauthConfiguration?: ExternalMcpOAuthConfigurationInput | null
  createdByOrgMembershipId: OrgMembershipId
  access: ExternalMcpAccessInput
}): Promise<ExternalMcpConnectionRow> {
  const id = createDenTypeId("externalMcpConnection")
  const oauthConfiguration: ExternalMcpOAuthConfiguration | null = input.authType === "oauth"
    ? {
        ...(input.oauthConfiguration ?? {
          version: 1,
          authorizationServerIssuer: null,
          requestedScopes: [],
        }),
        // Every new OAuth connection uses the deployment-wide callback. Rows
        // created before this contract keep their stored per-connection mode.
        callbackMode: "shared-v1",
      }
    : null
  await db.insert(ExternalMcpConnectionTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey ?? null,
    oauthConfiguration,
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

export async function listExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
    ))
}

export async function listDirectExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
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
  const existing = await listDirectExternalMcpConnectionAccess(input)
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

function directAccessKeys(rows: ExternalMcpConnectionAccessGrantRow[]): Set<string> {
  return new Set(rows.flatMap((row) => {
    if (row.orgWide) return ["org"]
    if (row.orgMembershipId) return [`member:${row.orgMembershipId}`]
    if (row.teamId) return [`team:${row.teamId}`]
    return []
  }))
}

function requestedAccessKeys(access: ExternalMcpAccessInput): Set<string> {
  if (access.orgWide) return new Set(["org"])
  return new Set([
    ...access.memberIds.map((id) => `member:${id}`),
    ...access.teamIds.map((id) => `team:${id}`),
  ])
}

function sameAccess(rows: ExternalMcpConnectionAccessGrantRow[], access: ExternalMcpAccessInput): boolean {
  const current = directAccessKeys(rows)
  const requested = requestedAccessKeys(access)
  return rows.length === current.size
    && current.size === requested.size
    && [...current].every((key) => requested.has(key))
}

export type UpdateExternalMcpConnectionInput = {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  expectedUpdatedAt: Date
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string
  oauthClient?: {
    clientId: string
    clientSecret?: string
    extra?: Record<string, unknown>
  }
  oauthConfiguration?: ExternalMcpOAuthConfiguration | null
  access: ExternalMcpAccessInput
  updatedByOrgMembershipId: OrgMembershipId
  validatedAt?: Date
}

export type UpdateExternalMcpConnectionResult =
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "marketplace_managed" }
  | {
    status: "updated"
    connection: ExternalMcpConnectionRow
    identityChanged: boolean
    reconnectionRequired: boolean
  }

/**
 * Atomically updates one tenant-scoped connection. The connection-row lock is
 * shared with enterprise OAuth persistence, so credential writes and identity
 * replacement have a deterministic winner. Direct grants are replaced without
 * touching marketplace-derived grants.
 */
export async function updateExternalMcpConnection(
  input: UpdateExternalMcpConnectionInput,
): Promise<UpdateExternalMcpConnectionResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (!existing) return { status: "not_found" }
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      return { status: "conflict" }
    }
    // Callback mode is an internal compatibility contract. Ordinary edits
    // preserve it so existing registrations keep their original redirect URI.
    if (
      input.authType === "oauth"
      && input.oauthConfiguration?.callbackMode === "legacy-v1"
      && existing.oauthConfiguration?.callbackMode === "shared-v1"
    ) {
      return { status: "conflict" }
    }

    const activeBindings = await tx
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .innerJoin(PluginTable, eq(PluginMcpRequirementBindingTable.pluginId, PluginTable.id))
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connectionId),
        eq(PluginTable.organizationId, input.organizationId),
        eq(PluginTable.status, "active"),
        isNull(PluginTable.deletedAt),
      ))
      .for("update")
    const oauthConfigurationChanged = input.oauthConfiguration !== undefined
      && !isDeepStrictEqual(existing.oauthConfiguration, input.oauthConfiguration)
    const marketplaceOwnedFieldsChanged = existing.url !== input.url
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
      || input.apiKey !== undefined
      || input.oauthClient !== undefined
      || oauthConfigurationChanged
    if (activeBindings.length > 0 && marketplaceOwnedFieldsChanged) {
      return { status: "marketplace_managed" }
    }

    const identityChanged = normalizeExternalMcpIdentityUrl(existing.url) !== normalizeExternalMcpIdentityUrl(input.url)
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
    const issuerChanged = input.oauthConfiguration !== undefined
      && existing.oauthConfiguration?.authorizationServerIssuer !== input.oauthConfiguration?.authorizationServerIssuer
    const callbackModeChanged = input.oauthConfiguration !== undefined
      && existing.oauthConfiguration?.callbackMode !== input.oauthConfiguration?.callbackMode
    const directGrants = await tx
      .select()
      .from(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
        isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      ))
      .for("update")
    const accessChanged = !sameAccess(directGrants, input.access)

    const clientRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existingClient = clientRows[0]
    const existingClientExtra = normalizeOAuthClientExtra(existingClient?.extra)
    const clientWasSdkRegistered = isSdkRegisteredOAuthClient(existingClientExtra)
    const clientRegistrationInvalidated = identityChanged
      || issuerChanged
      || (callbackModeChanged && clientWasSdkRegistered)
    const credentialsInvalidated = identityChanged || issuerChanged || callbackModeChanged
    const clientIdChanged = Boolean(input.oauthClient && existingClient?.clientId !== input.oauthClient.clientId)
    const clientSecretChanged = Boolean(
      input.oauthClient?.clientSecret !== undefined
      && existingClient?.clientSecret !== input.oauthClient.clientSecret,
    )
    const oauthClientChanged = identityChanged
      ? Boolean(existingClient || input.oauthClient)
      : Boolean(input.oauthClient && (!existingClient || clientIdChanged || clientSecretChanged))
    const apiKeyChanged = input.apiKey !== undefined && existing.apiKey !== input.apiKey
    const rowFieldsChanged = existing.name !== input.name
      || existing.url !== input.url
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
      || apiKeyChanged
      || identityChanged
      || oauthConfigurationChanged
    const changed = rowFieldsChanged || accessChanged || oauthClientChanged

    if (!changed) {
      return {
        status: "updated",
        connection: existing,
        identityChanged: false,
        reconnectionRequired: false,
      }
    }

    const changedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1))
    if (credentialsInvalidated) {
      await tx.delete(ConnectedAccountTable).where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.providerId, input.connectionId),
      ))
      if (clientRegistrationInvalidated) {
        await tx.delete(OrgOAuthClientTable).where(and(
          eq(OrgOAuthClientTable.organizationId, input.organizationId),
          eq(OrgOAuthClientTable.providerId, input.connectionId),
        ))
      }
      await tx
        .update(ExternalMcpConnectionTable)
        .set({
          name: input.name,
          url: input.url,
          authType: input.authType,
          credentialMode: input.credentialMode,
          oauthConfiguration: input.authType === "oauth" ? input.oauthConfiguration ?? null : null,
          apiKey: input.authType === "apikey" ? input.apiKey ?? null : null,
          accessToken: null,
          refreshToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          pendingCodeVerifier: null,
          connectedAt: input.authType === "none" ? input.validatedAt ?? changedAt : null,
          updatedAt: changedAt,
        })
        .where(and(
          eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
          eq(ExternalMcpConnectionTable.id, input.connectionId),
        ))
    } else {
      await tx
        .update(ExternalMcpConnectionTable)
        .set({
          name: input.name,
          url: input.url,
          authType: input.authType,
          credentialMode: input.credentialMode,
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          ...(input.oauthConfiguration !== undefined ? { oauthConfiguration: input.oauthConfiguration } : {}),
          ...(input.authType === "none" && input.validatedAt ? { connectedAt: input.validatedAt } : {}),
          updatedAt: changedAt,
        })
        .where(and(
          eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
          eq(ExternalMcpConnectionTable.id, input.connectionId),
        ))
    }

    if (accessChanged) {
      await tx.delete(ExternalMcpConnectionAccessGrantTable).where(and(
        eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
        isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      ))
      const grantRows = accessGrantRows({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        access: input.access,
        createdByOrgMembershipId: input.updatedByOrgMembershipId,
      })
      if (grantRows.length > 0) {
        await tx.insert(ExternalMcpConnectionAccessGrantTable).values(grantRows)
      }
    }

    if (input.authType === "oauth" && input.oauthClient) {
      if (clientRegistrationInvalidated || !existingClient) {
        await tx.insert(OrgOAuthClientTable).values({
          id: createDenTypeId("orgOAuthClient"),
          organizationId: input.organizationId,
          providerId: input.connectionId,
          clientId: input.oauthClient.clientId,
          clientSecret: input.oauthClient.clientSecret ?? null,
          extra: input.oauthClient.extra ?? null,
          createdByOrgMembershipId: input.updatedByOrgMembershipId,
        })
      } else if (oauthClientChanged) {
        await tx
          .update(OrgOAuthClientTable)
          .set({
            clientId: input.oauthClient.clientId,
            ...(input.oauthClient.clientSecret !== undefined
              ? { clientSecret: input.oauthClient.clientSecret }
              : clientIdChanged
                ? { clientSecret: null }
                : {}),
            ...(clientIdChanged ? { extra: null } : {}),
            ...(input.oauthClient.extra !== undefined ? { extra: input.oauthClient.extra } : {}),
          })
          .where(and(
            eq(OrgOAuthClientTable.organizationId, input.organizationId),
            eq(OrgOAuthClientTable.id, existingClient.id),
          ))
      }
    }

    const updatedRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
    const updated = updatedRows[0]
    if (!updated) throw new Error("External MCP connection disappeared during update.")
    return {
      status: "updated",
      connection: updated,
      identityChanged,
      reconnectionRequired: credentialsInvalidated && input.authType === "oauth",
    }
  })
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

type ExternalMcpIdentityRead<TValue> =
  | { current: false }
  | { current: true; value: TValue | null }

type ExternalMcpTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

function sameExternalMcpIdentity(
  current: ExternalMcpConnectionRow,
  expected: ExternalMcpConnectionRow,
): boolean {
  return current.id === expected.id
    && current.organizationId === expected.organizationId
    && normalizeExternalMcpIdentityUrl(current.url) === normalizeExternalMcpIdentityUrl(expected.url)
    && current.authType === expected.authType
    && current.credentialMode === expected.credentialMode
}

async function lockExternalMcpIdentity(
  tx: ExternalMcpTransaction,
  expected: ExternalMcpConnectionRow,
): Promise<ExternalMcpConnectionRow | null> {
  const rows = await tx
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, expected.organizationId),
      eq(ExternalMcpConnectionTable.id, expected.id),
    ))
    .limit(1)
    .for("update")
  const current = rows[0]
  return current && sameExternalMcpIdentity(current, expected) ? current : null
}

export async function readOrgOAuthClientForExternalMcpIdentity(
  connection: ExternalMcpConnectionRow,
): Promise<ExternalMcpIdentityRead<typeof OrgOAuthClientTable.$inferSelect>> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, connection)) return { current: false }
    const rows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, connection.organizationId),
        eq(OrgOAuthClientTable.providerId, connection.id),
      ))
      .limit(1)
    const value = rows[0]
      ? { ...rows[0], extra: normalizeOAuthClientExtra(rows[0].extra) }
      : null
    return { current: true, value }
  })
}

export async function upsertOrgOAuthClientForExternalMcpIdentity(input: {
  connection: ExternalMcpConnectionRow
  clientId: string
  clientSecret?: string | null
  extra?: Record<string, unknown> | null
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, input.connection)) return false
    const rows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.connection.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connection.id),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (existing) {
      await tx
        .update(OrgOAuthClientTable)
        .set({
          clientId: input.clientId,
          ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
          ...(input.extra !== undefined ? { extra: input.extra } : {}),
        })
        .where(eq(OrgOAuthClientTable.id, existing.id))
      return true
    }
    await tx.insert(OrgOAuthClientTable).values({
      id: createDenTypeId("orgOAuthClient"),
      organizationId: input.connection.organizationId,
      providerId: input.connection.id,
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? null,
      extra: input.extra ?? null,
      createdByOrgMembershipId: input.connection.createdByOrgMembershipId,
    })
    return true
  })
}

export async function deleteOrgOAuthClientForExternalMcpIdentity(
  connection: ExternalMcpConnectionRow,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, connection)) return false
    await tx.delete(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, connection.organizationId),
      eq(OrgOAuthClientTable.providerId, connection.id),
    ))
    return true
  })
}

export type ExternalMcpConnectedAccountChanges = {
  externalAccountId?: string | null
  scopes?: string[] | null
  accessToken?: string | null
  refreshToken?: string | null
  tokenType?: string | null
  expiresAt?: Date | null
  pendingCodeVerifier?: string | null
}

function connectedAccountChanges(input: ExternalMcpConnectedAccountChanges) {
  return {
    ...(input.externalAccountId !== undefined ? { externalAccountId: input.externalAccountId } : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    ...(input.accessToken !== undefined ? { accessToken: input.accessToken } : {}),
    ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
    ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.pendingCodeVerifier !== undefined ? { pendingCodeVerifier: input.pendingCodeVerifier } : {}),
  }
}

export async function readConnectedAccountForExternalMcpIdentity(input: {
  connection: ExternalMcpConnectionRow
  orgMembershipId: OrgMembershipId
}): Promise<ExternalMcpIdentityRead<typeof ConnectedAccountTable.$inferSelect>> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, input.connection)) return { current: false }
    const rows = await tx
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.connection.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.connection.id),
      ))
      .limit(1)
    const value = rows[0]
      ? { ...rows[0], scopes: normalizeConnectedAccountScopes(rows[0].scopes) }
      : null
    return { current: true, value }
  })
}

export async function upsertConnectedAccountForExternalMcpIdentity(input: {
  connection: ExternalMcpConnectionRow
  orgMembershipId: OrgMembershipId
  changes: ExternalMcpConnectedAccountChanges
  expectedPendingCodeVerifier?: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, input.connection)) return false
    const rows = await tx
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.connection.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.connection.id),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (
      input.expectedPendingCodeVerifier !== undefined
      && existing?.pendingCodeVerifier !== input.expectedPendingCodeVerifier
    ) {
      return false
    }
    if (existing) {
      await tx
        .update(ConnectedAccountTable)
        .set(connectedAccountChanges(input.changes))
        .where(eq(ConnectedAccountTable.id, existing.id))
      return true
    }
    await tx.insert(ConnectedAccountTable).values({
      id: createDenTypeId("connectedAccount"),
      organizationId: input.connection.organizationId,
      orgMembershipId: input.orgMembershipId,
      providerId: input.connection.id,
      externalAccountId: input.changes.externalAccountId ?? null,
      scopes: input.changes.scopes ?? null,
      accessToken: input.changes.accessToken ?? null,
      refreshToken: input.changes.refreshToken ?? null,
      tokenType: input.changes.tokenType ?? null,
      expiresAt: input.changes.expiresAt ?? null,
      pendingCodeVerifier: input.changes.pendingCodeVerifier ?? null,
    })
    return true
  })
}

export async function saveExternalMcpPendingCodeVerifierForIdentity(input: {
  connection: ExternalMcpConnectionRow
  codeVerifier: string | null
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, input.connection)) return false
    await tx
      .update(ExternalMcpConnectionTable)
      .set({ pendingCodeVerifier: input.codeVerifier })
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.connection.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connection.id),
      ))
    return true
  })
}

export async function saveExternalMcpTokensForIdentity(input: {
  connection: ExternalMcpConnectionRow
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
  expectedPendingCodeVerifier?: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const current = await lockExternalMcpIdentity(tx, input.connection)
    if (!current) return false
    if (
      input.expectedPendingCodeVerifier !== undefined
      && current.pendingCodeVerifier !== input.expectedPendingCodeVerifier
    ) {
      return false
    }
    await tx
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
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.connection.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connection.id),
      ))
    return true
  })
}

export async function clearExternalMcpTokensForIdentity(
  connection: ExternalMcpConnectionRow,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, connection)) return false
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        accessToken: null,
        refreshToken: null,
        tokenType: null,
        scope: null,
        expiresAt: null,
        connectedAt: null,
      })
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
        eq(ExternalMcpConnectionTable.id, connection.id),
      ))
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
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (!existing) return false

    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        ...(existing.authType === "apikey" ? { apiKey: null } : {}),
        accessToken: null,
        refreshToken: null,
        tokenType: null,
        scope: null,
        expiresAt: null,
        pendingCodeVerifier: null,
        connectedAt: null,
        updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
      })
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, existing.id),
      ))
    return true
  })
}

export type DisconnectExternalMcpMemberAccountResult =
  | { status: "not_found" }
  | { status: "not_per_member" }
  | { status: "not_connected" }
  | { status: "disconnected" }

export async function disconnectExternalMcpMemberAccount(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
}): Promise<DisconnectExternalMcpMemberAccountResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = rows[0]
    if (!connection) return { status: "not_found" }
    if (connection.credentialMode !== "per_member") return { status: "not_per_member" }

    const accountRows = await tx
      .select({ id: ConnectedAccountTable.id })
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const account = accountRows[0]
    if (!account) return { status: "not_connected" }

    await tx.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.id, account.id))
    return { status: "disconnected" }
  })
}
