import { createHash } from "node:crypto"
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpOAuthTransactionTable,
  ExternalMcpConnectionTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrgOAuthClientTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { roleIncludesPrivileged } from "../organization-member-guards.js"
import { ExternalMcpLifecycleDeadlineError } from "./external-mcp-diagnostics.js"

/**
 * CRUD for ExternalMcpConnectionTable and its access grants — the "add any
 * MCP server" concept. This is the only module that touches these tables
 * directly; the connector (external-mcp-client.ts) and routes go through
 * these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type ExternalMcpConnectionAccessGrantRow = typeof ExternalMcpConnectionAccessGrantTable.$inferSelect
export type ExternalMcpIdentitySnapshot = Omit<Pick<
  ExternalMcpConnectionRow,
  "id" | "organizationId" | "url" | "authType" | "credentialMode" | "createdByOrgMembershipId"
>, "url"> & { url: string | null | undefined }
export type ExternalMcpConnectionBinding = {
  connectionId: DenTypeId<"externalMcpConnection">
  pluginId: DenTypeId<"plugin">
  pluginName: string
}
export type ActiveExternalMcpConnectionBinding = ExternalMcpConnectionBinding
export type ExternalMcpOAuthTransactionRow = typeof ExternalMcpOAuthTransactionTable.$inferSelect
type OrgOAuthClientRow = typeof OrgOAuthClientTable.$inferSelect
type ConnectedAccountRow = typeof ConnectedAccountTable.$inferSelect

export type ExternalMcpOAuthClientRevision = Pick<
  OrgOAuthClientRow,
  "id" | "clientId" | "clientSecret" | "extra" | "updatedAt"
>

export type ExternalMcpOAuthClientValue = Pick<
  OrgOAuthClientRow,
  "clientId" | "clientSecret" | "extra" | "createdByOrgMembershipId"
>

export type ExternalMcpOAuthClientCasResult =
  | { status: "applied"; revision: ExternalMcpOAuthClientRevision | null }
  | { status: "client_changed" | "connection_changed" | "connection_missing" }

export type ExternalMcpConditionalCleanupResult = "missing" | "in_use" | "deleted"

export type ExternalMcpTokenRevision = string

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">
type PluginMcpRequirementBindingId = DenTypeId<"pluginMcpRequirementBinding">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type ExternalMcpAuthorizationActor = {
  orgMembershipId: OrgMembershipId
}

const EXTERNAL_MCP_OAUTH_AUTHORITY_CHANGED = "The initiating member no longer has authority to complete this MCP authorization."

export class ExternalMcpOAuthAuthorizationRevokedError extends Error {
  readonly code = "external_mcp_oauth_authorization_revoked"

  constructor() {
    super(EXTERNAL_MCP_OAUTH_AUTHORITY_CHANGED)
    this.name = "ExternalMcpOAuthAuthorizationRevokedError"
  }
}

export class ExternalMcpAccessTargetInvalidError extends Error {
  readonly code = "external_mcp_access_target_invalid"

  constructor() {
    super("External MCP access can only target active members and teams in the same organization.")
    this.name = "ExternalMcpAccessTargetInvalidError"
  }
}

export function isExternalMcpOAuthAuthorizationRevokedError(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof ExternalMcpOAuthAuthorizationRevokedError) return true
    if (typeof current !== "object" || current === null || !("cause" in current)) return false
    current = current.cause
  }
  return false
}

function oauthAuthorizationRevoked(): never {
  throw new ExternalMcpOAuthAuthorizationRevokedError()
}

function unique<TValue extends string>(values: TValue[]): TValue[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type StoredExternalMcpOAuthClientProvenance = "pre_registered" | "dcr" | "cimd"

function storedExternalMcpOAuthClientProvenance(
  extra: Record<string, unknown> | null,
): StoredExternalMcpOAuthClientProvenance {
  const explicit = extra?.registrationProvenance
  if (explicit === "pre_registered" || explicit === "dcr" || explicit === "cimd") return explicit
  if (extra?.enterpriseMcpRegistrationSource === "dynamic") return "dcr"
  if (extra?.enterpriseMcpRegistrationSource === "client-metadata") return "cimd"
  // Unmarked legacy metadata is ambiguous after secret-only administrator
  // rotations, so it is never safe to auto-delete as DCR.
  return "pre_registered"
}

function preRegisteredExternalMcpOAuthClientExtra(): Record<string, unknown> {
  return { registrationProvenance: "pre_registered" }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function legacyExternalMcpConnectionIdsFromPayload(payload: Record<string, unknown> | null): string[] {
  const ids = new Set<string>()
  const collect = (value: unknown) => {
    if (!isRecord(value) || value.openworkManaged !== "den_external_mcp") return
    if (typeof value.externalMcpConnectionId === "string" && value.externalMcpConnectionId.trim()) {
      ids.add(value.externalMcpConnectionId.trim())
    }
  }

  collect(payload)
  if (payload) {
    for (const key of ["mcpServers", "mcp"]) {
      const container = payload[key]
      if (!isRecord(container)) continue
      for (const value of Object.values(container)) collect(value)
    }
  }
  return [...ids]
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  )
}

function sameExternalMcpOAuthClientRevision(
  current: ExternalMcpOAuthClientRevision,
  expected: ExternalMcpOAuthClientRevision,
): boolean {
  return current.id === expected.id
    && current.clientId === expected.clientId
    && current.clientSecret === expected.clientSecret
    && current.updatedAt.getTime() === expected.updatedAt.getTime()
    && JSON.stringify(canonicalJson(current.extra)) === JSON.stringify(canonicalJson(expected.extra))
}

function sameExternalMcpConnectionSnapshot(
  current: ExternalMcpConnectionRow,
  expected: ExternalMcpConnectionRow,
): boolean {
  return current.id === expected.id
    && current.organizationId === expected.organizationId
    && current.name === expected.name
    && current.url === expected.url
    && current.authType === expected.authType
    && current.credentialMode === expected.credentialMode
    && current.apiKey === expected.apiKey
    && current.accessToken === expected.accessToken
    && current.refreshToken === expected.refreshToken
    && current.tokenType === expected.tokenType
    && current.scope === expected.scope
    && current.pendingCodeVerifier === expected.pendingCodeVerifier
    && current.oauthRegistrationLeaseToken === expected.oauthRegistrationLeaseToken
    && current.oauthAuthorizationEpoch === expected.oauthAuthorizationEpoch
    && current.connectedAt?.getTime() === expected.connectedAt?.getTime()
    && current.expiresAt?.getTime() === expected.expiresAt?.getTime()
    && current.oauthRegistrationLeaseStartedAt?.getTime() === expected.oauthRegistrationLeaseStartedAt?.getTime()
    && current.createdByOrgMembershipId === expected.createdByOrgMembershipId
    && current.createdAt.getTime() === expected.createdAt.getTime()
    && current.updatedAt.getTime() === expected.updatedAt.getTime()
    && JSON.stringify(current.requestedOAuthScopes) === JSON.stringify(expected.requestedOAuthScopes)
}

export function externalMcpOAuthClientRevision(
  client: ExternalMcpOAuthClientRevision,
): ExternalMcpOAuthClientRevision {
  return {
    id: client.id,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    extra: client.extra,
    updatedAt: client.updatedAt,
  }
}

export function externalMcpOAuthClientValue(
  client: ExternalMcpOAuthClientValue,
): ExternalMcpOAuthClientValue {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    extra: client.extra,
    createdByOrgMembershipId: client.createdByOrgMembershipId,
  }
}

function externalMcpTokenRevision(
  kind: "shared" | "per_member",
  input: {
    id: string
    accessToken: string | null
    refreshToken: string | null
    tokenType: string | null
    expiresAt: Date | null
    updatedAt: Date
    scope: string | string[] | null
    connectedAt: Date | null
  },
): ExternalMcpTokenRevision {
  return createHash("sha256")
    .update(JSON.stringify([
      kind,
      input.id,
      input.accessToken,
      input.refreshToken,
      input.tokenType,
      input.scope,
      input.expiresAt?.toISOString() ?? null,
      input.connectedAt?.toISOString() ?? null,
      input.updatedAt.toISOString(),
    ]))
    .digest("hex")
}

/** Opaque revision for the exact shared token set handed to an MCP request. */
export function externalMcpSharedTokenRevision(
  connection: Pick<
    ExternalMcpConnectionRow,
    "id" | "accessToken" | "refreshToken" | "tokenType" | "scope" | "expiresAt" | "connectedAt" | "updatedAt"
  >,
): ExternalMcpTokenRevision {
  return externalMcpTokenRevision("shared", connection)
}

/** Opaque revision for the exact per-member token set handed to an MCP request. */
export function externalMcpMemberTokenRevision(
  account: Pick<
    ConnectedAccountRow,
    "id" | "accessToken" | "refreshToken" | "tokenType" | "scopes" | "expiresAt" | "connectedAt" | "updatedAt"
  >,
): ExternalMcpTokenRevision {
  return externalMcpTokenRevision("per_member", {
    ...account,
    scope: account.scopes,
  })
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

export function normalizeExternalMcpIdentityUrl(value: string | null | undefined): string {
  const candidate = typeof value === "string" ? value.trim() : ""
  // Runtime callers can hold partial or expand-release snapshots even though
  // the persisted schema requires a URL. Keep those snapshots hashable: the
  // empty component cannot match a validated persisted URL, so credential
  // writes still fail closed at the identity fence instead of crashing first.
  if (!candidate) return ""
  try {
    const url = new URL(candidate)
    url.hash = ""
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname
    return `${url.protocol}//${url.host}${pathname}${url.search}`
  } catch {
    return candidate.replace(/\/+$/, "")
  }
}

/** A non-secret, one-way binding for OAuth state minted for this identity. */
export function externalMcpIdentityBinding(
  connection: Pick<ExternalMcpIdentitySnapshot, "url" | "authType" | "credentialMode">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      normalizeExternalMcpIdentityUrl(connection.url),
      connection.authType,
      connection.credentialMode,
    ]))
    .digest("base64url")
}

function externalMcpIdentityMatches(
  connection: Pick<ExternalMcpConnectionRow, "url" | "authType" | "credentialMode">,
  expectedIdentityBinding: string,
): boolean {
  return externalMcpIdentityBinding(connection) === expectedIdentityBinding
}

function assertExternalMcpIdentityBinding(
  connection: Pick<ExternalMcpConnectionRow, "url" | "authType" | "credentialMode">,
  expectedIdentityBinding: string,
): void {
  if (!externalMcpIdentityMatches(connection, expectedIdentityBinding)) {
    throw new Error("The external MCP connection identity changed while the operation was in progress.")
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

/**
 * Management views use every retained canonical binding because safe deletion
 * rejects every retained binding, including bindings owned by archived
 * plugins. Active-only consumers should use the narrower helper above.
 */
export async function listExternalMcpConnectionBindings(input: {
  organizationId: OrganizationId
  connectionIds: ExternalMcpConnectionId[]
}): Promise<ExternalMcpConnectionBinding[]> {
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
    ))
}

async function listActiveLegacyExternalMcpConnectionReferencesInTransaction(input: {
  tx: DbTransaction
  organizationId: OrganizationId
  connectionIds: ExternalMcpConnectionId[]
  lockRows: boolean
}): Promise<ExternalMcpConnectionBinding[]> {
  if (input.connectionIds.length === 0) return []
  const requestedConnectionIds = new Map<string, ExternalMcpConnectionId>(
    input.connectionIds.map((connectionId) => [connectionId, connectionId]),
  )
  const membershipsQuery = input.tx
    .select({
      configObjectId: ConfigObjectTable.id,
      pluginId: PluginTable.id,
      pluginName: PluginTable.name,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(PluginConfigObjectTable.configObjectId, ConfigObjectTable.id))
    .innerJoin(PluginTable, eq(PluginConfigObjectTable.pluginId, PluginTable.id))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(ConfigObjectTable.organizationId, input.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginTable.organizationId, input.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
    ))
  const memberships = input.lockRows
    ? await membershipsQuery.for("update")
    : await membershipsQuery
  if (memberships.length === 0) return []

  const versionsQuery = input.tx
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, input.organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, memberships.map((row) => row.configObjectId)),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const versionRows = input.lockRows
    ? await versionsQuery.for("update")
    : await versionsQuery
  const versions = new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  for (const row of versionRows) {
    if (!versions.has(row.configObjectId)) versions.set(row.configObjectId, row)
  }

  const references = new Map<string, ExternalMcpConnectionBinding>()
  for (const membership of memberships) {
    const version = versions.get(membership.configObjectId)
    if (!version) continue
    const payload = isRecord(version.normalizedPayloadJson)
      ? version.normalizedPayloadJson
      : parseJsonObject(version.rawSourceText)
    for (const candidate of legacyExternalMcpConnectionIdsFromPayload(payload)) {
      const connectionId = requestedConnectionIds.get(candidate)
      if (!connectionId) continue
      const reference = { connectionId, pluginId: membership.pluginId, pluginName: membership.pluginName }
      references.set(`${connectionId}:${membership.pluginId}`, reference)
    }
  }
  return [...references.values()]
}

/** Active legacy plugin payloads deployed before canonical binding rows. */
export async function listActiveLegacyExternalMcpConnectionReferences(input: {
  organizationId: OrganizationId
  connectionIds: ExternalMcpConnectionId[]
}): Promise<ExternalMcpConnectionBinding[]> {
  return db.transaction((tx) => listActiveLegacyExternalMcpConnectionReferencesInTransaction({
    ...input,
    tx,
    lockRows: false,
  }))
}

/**
 * Public OAuth Client ID Metadata Documents are fetched by an authorization
 * server without an organization session. Keep this narrowly scoped lookup
 * separate from every organization-authorized connection read.
 */
export async function getExternalMcpConnectionForClientMetadata(
  connectionId: ExternalMcpConnectionId,
): Promise<Pick<ExternalMcpConnectionRow, "id" | "requestedOAuthScopes"> | null> {
  const rows = await db
    .select({
      id: ExternalMcpConnectionTable.id,
      requestedOAuthScopes: ExternalMcpConnectionTable.requestedOAuthScopes,
    })
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.id, connectionId),
      eq(ExternalMcpConnectionTable.authType, "oauth"),
    ))
    .limit(1)
  return rows[0] ?? null
}

export type ExternalMcpAccessInput = {
  orgWide: boolean
  memberIds: OrgMembershipId[]
  teamIds: TeamId[]
}

const MAX_EXTERNAL_MCP_REQUESTED_SCOPES = 100
const MAX_EXTERNAL_MCP_SCOPE_LENGTH = 512
const MAX_EXTERNAL_MCP_SCOPE_TOTAL_LENGTH = 8_192
const OAUTH_SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

/**
 * Scope values can originate in publisher manifests, so keep the persisted
 * OAuth fallback deliberately small and tokenized. The live challenge and
 * protected-resource metadata still take precedence in the MCP SDK.
 */
export function normalizeExternalMcpRequestedOAuthScopes(
  values: readonly string[] | null | undefined,
): string[] | null {
  if (!values?.length) return null
  const scopes: string[] = []
  const seen = new Set<string>()
  let totalLength = 0
  for (const value of values) {
    for (const candidate of value.split(/\s+/g)) {
      const scope = candidate.trim()
      if (!scope || seen.has(scope)) continue
      if (scope.length > MAX_EXTERNAL_MCP_SCOPE_LENGTH) {
        throw new Error(`OAuth scope values must be at most ${MAX_EXTERNAL_MCP_SCOPE_LENGTH} characters.`)
      }
      if (!OAUTH_SCOPE_TOKEN_PATTERN.test(scope)) {
        throw new Error("OAuth scope values must use the RFC 6749 printable ASCII token grammar.")
      }
      if (scopes.length >= MAX_EXTERNAL_MCP_REQUESTED_SCOPES) {
        throw new Error(`At most ${MAX_EXTERNAL_MCP_REQUESTED_SCOPES} OAuth scopes may be requested.`)
      }
      const separatorLength = scopes.length > 0 ? 1 : 0
      if (totalLength + separatorLength + scope.length > MAX_EXTERNAL_MCP_SCOPE_TOTAL_LENGTH) {
        throw new Error(`Requested OAuth scopes must total at most ${MAX_EXTERNAL_MCP_SCOPE_TOTAL_LENGTH} characters.`)
      }
      seen.add(scope)
      scopes.push(scope)
      totalLength += separatorLength + scope.length
    }
  }
  return scopes.length > 0 ? scopes : null
}

function externalMcpRequestedOAuthScopeSetsMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizeExternalMcpRequestedOAuthScopes(left) ?? []
  const normalizedRight = normalizeExternalMcpRequestedOAuthScopes(right) ?? []
  if (normalizedLeft.length !== normalizedRight.length) return false
  const rightSet = new Set(normalizedRight)
  return normalizedLeft.every((scope) => rightSet.has(scope))
}

export type ExternalMcpConnectionCreateInput = {
  organizationId: OrganizationId
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string | null
  requestedOAuthScopes?: string[] | null
  createdByOrgMembershipId: OrgMembershipId
  access: ExternalMcpAccessInput
}

export type PreparedExternalMcpConnection = {
  connection: ExternalMcpConnectionRow
  access: ExternalMcpAccessInput
}

export type PreparedExternalMcpOAuthClient = {
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown>
}

/**
 * Allocate the final connection identity without making it visible. Direct
 * create routes can use this complete in-memory row for live validation, then
 * publish it only after the remote server has proved it can initialize.
 */
export function prepareExternalMcpConnection(
  input: ExternalMcpConnectionCreateInput,
): PreparedExternalMcpConnection {
  const id = createDenTypeId("externalMcpConnection")
  const now = new Date()
  return {
    connection: {
      id,
      organizationId: input.organizationId,
      name: input.name,
      url: input.url,
      authType: input.authType,
      credentialMode: input.credentialMode,
      apiKey: input.apiKey ?? null,
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      requestedOAuthScopes: input.authType === "oauth"
        ? normalizeExternalMcpRequestedOAuthScopes(input.requestedOAuthScopes)
        : null,
      scope: null,
      oauthRegistrationLeaseToken: null,
      oauthRegistrationLeaseStartedAt: null,
      oauthAuthorizationEpoch: 0,
      expiresAt: null,
      pendingCodeVerifier: null,
      connectedAt: null,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      createdAt: now,
      updatedAt: now,
    },
    access: input.access,
  }
}

export async function listExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
} | ExternalMcpConnectionId): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  const connectionId = typeof input === "string" ? input : input.connectionId
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(typeof input === "string"
      ? eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId)
      : and(
          eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
          eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId),
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

/**
 * Resolve every assignment target while holding the same transaction fence as
 * grant replacement. This closes the stale-member/cross-tenant window between
 * route validation and delete+insert, while using the same connection ->
 * member -> team -> grant lock order as OAuth callback credential commits.
 */
async function assertExternalMcpAccessTargetsForUpdate(input: {
  access: ExternalMcpAccessInput
  organizationId: OrganizationId
  tx: DbTransaction
}): Promise<void> {
  if (input.access.orgWide) return
  const memberIds = unique(input.access.memberIds)
  const teamIds = unique(input.access.teamIds)
  const members = memberIds.length === 0
    ? []
    : await input.tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.organizationId, input.organizationId),
        inArray(MemberTable.id, memberIds),
        isNull(MemberTable.removedAt),
        isNotNull(MemberTable.userId),
      ))
      .for("update")
  const teams = teamIds.length === 0
    ? []
    : await input.tx
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(and(
        eq(TeamTable.organizationId, input.organizationId),
        inArray(TeamTable.id, teamIds),
      ))
      .for("update")

  if (members.length !== memberIds.length || teams.length !== teamIds.length) {
    throw new ExternalMcpAccessTargetInvalidError()
  }
}

/**
 * Publish a prepared connection, its direct assignment, and an optional
 * administrator-supplied OAuth client as one database fact. Nothing is
 * observable if any insert fails, and the client can never outlive a failed
 * connection create.
 */
export async function commitPreparedExternalMcpConnection(input: {
  commitExpiresAt?: number
  prepared: PreparedExternalMcpConnection
  oauthClient?: PreparedExternalMcpOAuthClient
}): Promise<ExternalMcpConnectionRow> {
  const connection = input.prepared.connection
  if (input.oauthClient && connection.authType !== "oauth") {
    throw new Error("OAuth client metadata is only valid for an OAuth MCP connection.")
  }

  return db.transaction(async (tx) => {
    if (input.commitExpiresAt !== undefined && Date.now() >= input.commitExpiresAt) {
      throw new ExternalMcpLifecycleDeadlineError()
    }
    await tx.insert(ExternalMcpConnectionTable).values({
      id: connection.id,
      organizationId: connection.organizationId,
      name: connection.name,
      url: connection.url,
      authType: connection.authType,
      credentialMode: connection.credentialMode,
      apiKey: connection.apiKey,
      requestedOAuthScopes: connection.requestedOAuthScopes,
      connectedAt: connection.connectedAt,
      createdByOrgMembershipId: connection.createdByOrgMembershipId,
    })

    // Establish the same row fence used by delete and every credential writer
    // before publishing dependent rows. This is deliberately an insert (not
    // an upsert): a collision or concurrent mutation aborts the whole create.
    const persistedRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
        eq(ExternalMcpConnectionTable.id, connection.id),
      ))
      .limit(1)
      .for("update")
    const persisted = persistedRows[0]
    if (!persisted) throw new Error("Failed to prepare the external MCP connection for commit.")

    await assertExternalMcpAccessTargetsForUpdate({
      access: input.prepared.access,
      organizationId: connection.organizationId,
      tx,
    })

    const grants = accessGrantRows({
      organizationId: connection.organizationId,
      connectionId: connection.id,
      access: input.prepared.access,
      createdByOrgMembershipId: connection.createdByOrgMembershipId,
    })
    if (grants.length > 0) {
      await tx.insert(ExternalMcpConnectionAccessGrantTable).values(grants)
    }

    if (input.oauthClient) {
      await tx.insert(OrgOAuthClientTable).values({
        id: createDenTypeId("orgOAuthClient"),
        organizationId: connection.organizationId,
        providerId: connection.id,
        clientId: input.oauthClient.clientId,
        clientSecret: input.oauthClient.clientSecret,
        extra: input.oauthClient.extra,
        createdByOrgMembershipId: connection.createdByOrgMembershipId,
      })
    }
    // Returning from this callback commits the transaction. Recheck after all
    // dependent writes so elapsed work rolls the entire graph back instead of
    // becoming visible after the caller's bounded request lifecycle.
    if (input.commitExpiresAt !== undefined && Date.now() >= input.commitExpiresAt) {
      throw new ExternalMcpLifecycleDeadlineError()
    }
    return persisted
  })
}

export async function createExternalMcpConnection(
  input: ExternalMcpConnectionCreateInput,
): Promise<ExternalMcpConnectionRow> {
  return commitPreparedExternalMcpConnection({
    prepared: prepareExternalMcpConnection(input),
  })
}

/** Full-replace semantics (mirrors the LLM-provider access pattern): the caller sends the complete desired access set. */
export async function replaceExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db.transaction(async (tx) => {
    const connection = await tx.select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (!connection[0]) throw new Error("The external MCP connection no longer exists.")
    await assertExternalMcpAccessTargetsForUpdate({
      access: input.access,
      organizationId: input.organizationId,
      tx,
    })
    await tx
      .delete(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
        isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      ))

    const rows = accessGrantRows(input)
    if (rows.length > 0) await tx.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  })
}

export async function replaceExternalMcpConnectionAccessForPluginBinding(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  bindingId: PluginMcpRequirementBindingId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db.transaction(async (tx) => {
    const connection = await tx.select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (!connection[0]) throw new Error("The external MCP connection no longer exists.")
    const binding = await tx.select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.id, input.bindingId),
        eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (!binding[0]) throw new Error("The plugin MCP requirement binding no longer exists.")
    await assertExternalMcpAccessTargetsForUpdate({
      access: input.access,
      organizationId: input.organizationId,
      tx,
    })
    await tx
      .delete(ExternalMcpConnectionAccessGrantTable)
      .where(eq(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, input.bindingId))

    const rows = accessGrantRows(input)
    if (rows.length > 0) await tx.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  })
}

export async function mergeExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db.transaction(async (tx) => {
    const connection = await tx.select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (!connection[0]) throw new Error("The external MCP connection no longer exists.")
    await assertExternalMcpAccessTargetsForUpdate({
      access: input.access,
      organizationId: input.organizationId,
      tx,
    })
    const existing = await tx
      .select()
      .from(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
        isNull(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId),
      ))
      .for("update")
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

    if (rows.length > 0) await tx.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  })
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
  }
  requestedOAuthScopes?: string[]
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
    await assertExternalMcpAccessTargetsForUpdate({
      access: input.access,
      organizationId: input.organizationId,
      tx,
    })

    const requestedOAuthScopes = input.authType === "oauth"
      ? input.requestedOAuthScopes !== undefined
        ? normalizeExternalMcpRequestedOAuthScopes(input.requestedOAuthScopes)
        : existing.authType === "oauth"
          ? existing.requestedOAuthScopes
          : null
      : null
    const requestedScopesChanged = !externalMcpRequestedOAuthScopeSetsMatch(
      existing.requestedOAuthScopes ?? [],
      requestedOAuthScopes ?? [],
    )

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
    const marketplaceOwnedFieldsChanged = existing.url !== input.url
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
      || input.apiKey !== undefined
      || input.oauthClient !== undefined
      || requestedScopesChanged
    if (activeBindings.length > 0 && marketplaceOwnedFieldsChanged) {
      return { status: "marketplace_managed" }
    }

    const identityChanged = normalizeExternalMcpIdentityUrl(existing.url) !== normalizeExternalMcpIdentityUrl(input.url)
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
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
    const clientIdChanged = Boolean(input.oauthClient && existingClient?.clientId !== input.oauthClient.clientId)
    const clientSecretChanged = Boolean(
      input.oauthClient?.clientSecret !== undefined
      && existingClient?.clientSecret !== input.oauthClient.clientSecret,
    )
    const oauthClientChanged = identityChanged
      ? Boolean(existingClient || input.oauthClient)
      : Boolean(input.oauthClient && (!existingClient || clientIdChanged || clientSecretChanged))
    const administratorReplacedOAuthClient = Boolean(
      input.oauthClient && (!existingClient || clientIdChanged || clientSecretChanged),
    )
    // Switching OAuth applications changes the authorization principal just
    // as surely as changing the server URL or requested scopes. Fence all
    // pending callbacks and discard tokens issued to the previous client.
    const authorizationChanged = identityChanged || requestedScopesChanged || clientIdChanged
    const apiKeyChanged = input.apiKey !== undefined && existing.apiKey !== input.apiKey
    const rowFieldsChanged = existing.name !== input.name
      || existing.url !== input.url
      || existing.authType !== input.authType
      || existing.credentialMode !== input.credentialMode
      || apiKeyChanged
      || requestedScopesChanged
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
    if (authorizationChanged) {
      await tx.delete(ConnectedAccountTable).where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.providerId, input.connectionId),
      ))
      await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
      ))
      const rotateDynamicClient = requestedScopesChanged
        && !administratorReplacedOAuthClient
        && existingClient
        && storedExternalMcpOAuthClientProvenance(existingClient.extra) === "dcr"
      if (identityChanged || rotateDynamicClient) {
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
          apiKey: input.authType === "apikey" ? input.apiKey ?? null : null,
          requestedOAuthScopes,
          accessToken: null,
          refreshToken: null,
          tokenType: null,
          scope: null,
          expiresAt: null,
          pendingCodeVerifier: null,
          oauthRegistrationLeaseToken: null,
          oauthRegistrationLeaseStartedAt: null,
          oauthAuthorizationEpoch: sql`${ExternalMcpConnectionTable.oauthAuthorizationEpoch} + 1`,
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
      if (identityChanged || !existingClient) {
        await tx.insert(OrgOAuthClientTable).values({
          id: createDenTypeId("orgOAuthClient"),
          organizationId: input.organizationId,
          providerId: input.connectionId,
          clientId: input.oauthClient.clientId,
          clientSecret: input.oauthClient.clientSecret ?? null,
          extra: preRegisteredExternalMcpOAuthClientExtra(),
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
            // Administrator-entered credentials are always pre-registered.
            // Clear DCR/CIMD provenance even for a secret-only rotation so a
            // later invalid_client response cannot delete a manual secret.
            extra: preRegisteredExternalMcpOAuthClientExtra(),
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
      reconnectionRequired: authorizationChanged && input.authType === "oauth",
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

async function hasActiveSourcedMcpAccessForCommit(input: {
  tx: DbTransaction
  connection: Pick<ExternalMcpConnectionRow, "id" | "organizationId" | "url">
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
  bindingIds: PluginMcpRequirementBindingId[]
}): Promise<boolean> {
  if (input.bindingIds.length === 0) return false
  const bindings = await input.tx
    .select({
      configObjectId: PluginMcpRequirementBindingTable.configObjectId,
      configObjectTitle: ConfigObjectTable.title,
      id: PluginMcpRequirementBindingTable.id,
      pluginId: PluginMcpRequirementBindingTable.pluginId,
      serverName: PluginMcpRequirementBindingTable.serverName,
    })
    .from(PluginMcpRequirementBindingTable)
    .innerJoin(PluginTable, eq(PluginTable.id, PluginMcpRequirementBindingTable.pluginId))
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginMcpRequirementBindingTable.configObjectId))
    .innerJoin(PluginConfigObjectTable, and(
      eq(PluginConfigObjectTable.pluginId, PluginMcpRequirementBindingTable.pluginId),
      eq(PluginConfigObjectTable.configObjectId, PluginMcpRequirementBindingTable.configObjectId),
    ))
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.connection.organizationId),
      eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connection.id),
      inArray(PluginMcpRequirementBindingTable.id, input.bindingIds),
      eq(PluginTable.organizationId, input.connection.organizationId),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(ConfigObjectTable.organizationId, input.connection.organizationId),
      eq(ConfigObjectTable.objectType, "mcp"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
      eq(PluginConfigObjectTable.organizationId, input.connection.organizationId),
      isNull(PluginConfigObjectTable.removedAt),
    ))
    .for("update")
  if (bindings.length === 0) return false

  const filters = resourceGrantFilters(input)
  const configObjectIds = unique(bindings.map((binding) => binding.configObjectId))
  const pluginIds = unique(bindings.map((binding) => binding.pluginId))
  const configObjectGrants = await input.tx
    .select({ configObjectId: ConfigObjectAccessGrantTable.configObjectId })
    .from(ConfigObjectAccessGrantTable)
    .where(and(
      eq(ConfigObjectAccessGrantTable.organizationId, input.connection.organizationId),
      inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds),
      isNull(ConfigObjectAccessGrantTable.removedAt),
      filters.configObjectAccess,
    ))
    .for("update")
  const pluginGrants = await input.tx
    .select({ pluginId: PluginAccessGrantTable.pluginId })
    .from(PluginAccessGrantTable)
    .where(and(
      eq(PluginAccessGrantTable.organizationId, input.connection.organizationId),
      inArray(PluginAccessGrantTable.pluginId, pluginIds),
      isNull(PluginAccessGrantTable.removedAt),
      filters.pluginAccess,
    ))
    .for("update")
  const marketplaceMemberships = await input.tx
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId, pluginId: MarketplacePluginTable.pluginId })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      eq(MarketplacePluginTable.organizationId, input.connection.organizationId),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
      isNull(MarketplacePluginTable.removedAt),
      eq(MarketplaceTable.organizationId, input.connection.organizationId),
      eq(MarketplaceTable.status, "active"),
      isNull(MarketplaceTable.deletedAt),
    ))
    .for("update")
  const marketplaceIds = unique(marketplaceMemberships.map((row) => row.marketplaceId))
  const marketplaceGrants = marketplaceIds.length === 0 ? [] : await input.tx
    .select({ marketplaceId: MarketplaceAccessGrantTable.marketplaceId })
    .from(MarketplaceAccessGrantTable)
    .where(and(
      eq(MarketplaceAccessGrantTable.organizationId, input.connection.organizationId),
      inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIds),
      isNull(MarketplaceAccessGrantTable.removedAt),
      filters.marketplaceAccess,
    ))
    .for("update")
  const versions = await input.tx
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(
      eq(ConfigObjectVersionTable.organizationId, input.connection.organizationId),
      inArray(ConfigObjectVersionTable.configObjectId, configObjectIds),
    ))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .for("update")

  const accessibleConfigObjects = new Set(configObjectGrants.map((row) => row.configObjectId))
  const accessiblePlugins = new Set(pluginGrants.map((row) => row.pluginId))
  const accessibleMarketplaces = new Set(marketplaceGrants.map((row) => row.marketplaceId))
  const marketplacePlugins = new Set(marketplaceMemberships.flatMap((row) => (
    accessibleMarketplaces.has(row.marketplaceId) ? [row.pluginId] : []
  )))
  const latestVersions = new Map<string, typeof ConfigObjectVersionTable.$inferSelect>()
  for (const version of versions) {
    if (!latestVersions.has(version.configObjectId)) latestVersions.set(version.configObjectId, version)
  }

  return bindings.some((binding) => {
    if (
      !accessibleConfigObjects.has(binding.configObjectId)
      && !accessiblePlugins.has(binding.pluginId)
      && !marketplacePlugins.has(binding.pluginId)
    ) return false
    const version = latestVersions.get(binding.configObjectId)
    if (!version) return false
    const entry = marketplaceMcpServerEntries(versionServerSpec(version), binding.configObjectTitle)
      .find((candidate) => candidate.name === binding.serverName)
    const declaredUrl = readString(entry?.config.url)
    return Boolean(declaredUrl)
      && normalizeExternalMcpIdentityUrl(input.connection.url) === normalizeExternalMcpIdentityUrl(declaredUrl!)
  })
}

/**
 * Revalidates the browser authorization actor at the credential commit
 * boundary. Every row that can make the result true is read FOR UPDATE, so a
 * concurrent role, team-membership, or assignment revocation has one clear
 * ordering with the token write: either it commits first and this fails, or
 * this commits first and the later revocation takes effect afterwards.
 *
 * Keep this exported for the package-first enterprise MCP persistence path;
 * both OAuth runtimes must enforce the same Den authority policy.
 */
export async function assertExternalMcpOAuthAuthorizationActorForCommit(input: {
  tx: DbTransaction
  connection: Pick<ExternalMcpConnectionRow, "id" | "organizationId" | "credentialMode" | "url">
  authorizationActor: ExternalMcpAuthorizationActor
}): Promise<void> {
  const memberRows = await input.tx
    .select({
      id: MemberTable.id,
      role: MemberTable.role,
      userId: MemberTable.userId,
    })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.id, input.authorizationActor.orgMembershipId),
      eq(MemberTable.organizationId, input.connection.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
    .for("update")
  const member = memberRows[0]
  if (!member?.userId) oauthAuthorizationRevoked()

  if (input.connection.credentialMode === "shared") {
    if (!roleIncludesPrivileged(member.role)) {
      oauthAuthorizationRevoked()
    }
    return
  }

  const teamRows = await input.tx
    .select({ id: TeamTable.id })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(
      eq(TeamMemberTable.orgMembershipId, member.id),
      eq(TeamTable.organizationId, input.connection.organizationId),
    ))
    .for("update")
  const teamIds = teamRows.map((team) => team.id)
  const assignment = teamIds.length > 0
    ? or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, member.id),
        inArray(ExternalMcpConnectionAccessGrantTable.teamId, teamIds),
      )
    : or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, member.id),
      )
  const grantRows = await input.tx
    .select({
      bindingId: ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId,
      id: ExternalMcpConnectionAccessGrantTable.id,
    })
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(and(
      eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.connection.organizationId),
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connection.id),
      assignment,
    ))
    .for("update")
  if (grantRows.length === 0) oauthAuthorizationRevoked()
  if (grantRows.some((grant) => grant.bindingId === null)) return
  const hasSourcedAccess = await hasActiveSourcedMcpAccessForCommit({
    tx: input.tx,
    connection: input.connection,
    orgMembershipId: member.id,
    teamIds,
    bindingIds: grantRows.flatMap((grant) => grant.bindingId ? [grant.bindingId] : []),
  })
  if (!hasSourcedAccess) oauthAuthorizationRevoked()
}

export class ExternalMcpConnectionInUseError extends Error {
  constructor() {
    super("Remove this connection from its marketplace plugins before deleting it.")
    this.name = "ExternalMcpConnectionInUseError"
  }
}

export async function deleteExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  refuseIfBound?: boolean
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
    if (input.refuseIfBound) {
      const bindingRows = await tx
        .select({ id: PluginMcpRequirementBindingTable.id })
        .from(PluginMcpRequirementBindingTable)
        .where(and(
          eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
          eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, existing.id),
        ))
        .limit(1)
        .for("update")
      if (bindingRows[0]) throw new ExternalMcpConnectionInUseError()
      const legacyReferences = await listActiveLegacyExternalMcpConnectionReferencesInTransaction({
        tx,
        organizationId: input.organizationId,
        connectionIds: [existing.id],
        lockRows: true,
      })
      if (legacyReferences[0]) throw new ExternalMcpConnectionInUseError()
    }
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
    await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
      eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, existing.id),
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
  expected: ExternalMcpIdentitySnapshot,
): boolean {
  return current.id === expected.id
    && current.organizationId === expected.organizationId
    && normalizeExternalMcpIdentityUrl(current.url) === normalizeExternalMcpIdentityUrl(expected.url)
    && current.authType === expected.authType
    && current.credentialMode === expected.credentialMode
}

async function lockExternalMcpIdentity(
  tx: ExternalMcpTransaction,
  expected: ExternalMcpIdentitySnapshot,
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
    return { current: true, value: rows[0] ?? null }
  })
}

export async function upsertOrgOAuthClientForExternalMcpIdentity(input: {
  connection: ExternalMcpIdentitySnapshot
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
    return { current: true, value: rows[0] ?? null }
  })
}

export async function upsertConnectedAccountForExternalMcpIdentity(input: {
  connection: ExternalMcpConnectionRow
  orgMembershipId: OrgMembershipId
  changes: ExternalMcpConnectedAccountChanges
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
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!await lockExternalMcpIdentity(tx, input.connection)) return false
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

/**
 * Remove a newly-created connection during a multi-step import rollback, but
 * only while it is still an unused shell.
 *
 * Every credential/binding writer takes the same connection-row lock before
 * committing. This makes the decision atomic with concurrent plugin imports,
 * OAuth starts/completions, DCR, and client rotation: a writer that wins first
 * makes cleanup return `in_use`; cleanup that wins first makes the writer see
 * a missing connection. The API key is intentionally not a blocker because
 * it is part of the import-created shell itself, whereas tokens and OAuth
 * state can only appear through a later connection lifecycle.
 *
 * A saga may also supply the exact shell snapshot and OAuth-client revision
 * it created. In that mode the client and connection are reclaimed together
 * under the connection lock; any rename, rotation, OAuth start, binding, or
 * other adoption signal makes cleanup preserve both rows.
 */
export async function deleteExternalMcpConnectionIfUnused(input: {
  allowConnectedAt?: boolean
  expectedConnection?: ExternalMcpConnectionRow
  expectedOwnedOAuthClient?: ExternalMcpOAuthClientRevision
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConditionalCleanupResult> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return "missing"

    if (
      (input.expectedConnection !== undefined && !sameExternalMcpConnectionSnapshot(connection, input.expectedConnection))
      || (!input.allowConnectedAt && connection.connectedAt !== null)
      || connection.accessToken !== null
      || connection.refreshToken !== null
      || connection.tokenType !== null
      || connection.scope !== null
      || connection.expiresAt !== null
      || connection.pendingCodeVerifier !== null
      || connection.oauthRegistrationLeaseToken !== null
      || connection.oauthRegistrationLeaseStartedAt !== null
    ) return "in_use"

    const bindingRows = await tx
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, connection.id),
      ))
      .limit(1)
      .for("update")
    if (bindingRows[0]) return "in_use"

    const accessRows = await tx
      .select({ id: ExternalMcpConnectionAccessGrantTable.id })
      .from(ExternalMcpConnectionAccessGrantTable)
      .where(and(
        eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connection.id),
      ))
      .limit(1)
      .for("update")
    if (accessRows[0]) return "in_use"

    const accountRows = await tx
      .select({ id: ConnectedAccountTable.id })
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.providerId, connection.id),
      ))
      .limit(1)
      .for("update")
    if (accountRows[0]) return "in_use"

    const transactionRows = await tx
      .select({ stateKey: ExternalMcpOAuthTransactionTable.stateKey })
      .from(ExternalMcpOAuthTransactionTable)
      .where(and(
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
      ))
      .limit(1)
      .for("update")
    if (transactionRows[0]) return "in_use"

    const clientRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, connection.id),
      ))
      .limit(1)
      .for("update")
    const client = clientRows[0]
    if (input.expectedOwnedOAuthClient) {
      if (!client || !sameExternalMcpOAuthClientRevision(client, input.expectedOwnedOAuthClient)) return "in_use"
      await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.id, client.id))
    } else if (client) {
      return "in_use"
    }

    await tx
      .delete(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, connection.id),
      ))
    return "deleted"
  })
}

const EXTERNAL_MCP_OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000
const MAX_EXTERNAL_MCP_PENDING_OAUTH_TRANSACTIONS_PER_MEMBER = 8
const MAX_EXTERNAL_MCP_EXPIRED_OAUTH_TRANSACTION_CLEANUP = 32

/**
 * Sweep expired state rows across every connection. All transaction rows have
 * a required short expiry, so this also bounds retention for rows orphaned by
 * an interrupted/raw connection or member lifecycle. The local per-connection
 * prune in saveExternalMcpOAuthTransaction remains useful for quota pressure.
 */
export async function cleanupExpiredExternalMcpOAuthTransactions(input: {
  now?: Date
  limit?: number
} = {}): Promise<{ deleted: number; limitReached: boolean }> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 500
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
    throw new Error("External MCP OAuth transaction cleanup limit must be an integer from 1 through 5000.")
  }

  return db.transaction(async (tx) => {
    const expiredTransactions = await tx
      .select({
        stateKey: ExternalMcpOAuthTransactionTable.stateKey,
        organizationId: ExternalMcpOAuthTransactionTable.organizationId,
        connectionId: ExternalMcpOAuthTransactionTable.externalMcpConnectionId,
        orgMembershipId: ExternalMcpOAuthTransactionTable.orgMembershipId,
        codeVerifier: ExternalMcpOAuthTransactionTable.codeVerifier,
      })
      .from(ExternalMcpOAuthTransactionTable)
      .where(lte(ExternalMcpOAuthTransactionTable.expiresAt, now))
      .orderBy(
        ExternalMcpOAuthTransactionTable.expiresAt,
        ExternalMcpOAuthTransactionTable.stateKey,
      )
      .limit(limit)
      .for("update")

    if (expiredTransactions.length > 0) {
      await tx.delete(ExternalMcpOAuthTransactionTable).where(inArray(
        ExternalMcpOAuthTransactionTable.stateKey,
        expiredTransactions.map((transaction) => transaction.stateKey),
      ))
      for (const transaction of expiredTransactions) {
        const connections = await tx
          .select({ id: ExternalMcpConnectionTable.id, pendingCodeVerifier: ExternalMcpConnectionTable.pendingCodeVerifier })
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.organizationId, transaction.organizationId),
            eq(ExternalMcpConnectionTable.id, transaction.connectionId),
          ))
          .limit(1)
          .for("update")
        if (connections[0]?.pendingCodeVerifier === transaction.codeVerifier) {
          await tx.update(ExternalMcpConnectionTable)
            .set({ pendingCodeVerifier: null })
            .where(eq(ExternalMcpConnectionTable.id, connections[0].id))
        }
        const accounts = await tx
          .select({ id: ConnectedAccountTable.id, pendingCodeVerifier: ConnectedAccountTable.pendingCodeVerifier })
          .from(ConnectedAccountTable)
          .where(and(
            eq(ConnectedAccountTable.organizationId, transaction.organizationId),
            eq(ConnectedAccountTable.orgMembershipId, transaction.orgMembershipId),
            eq(ConnectedAccountTable.providerId, transaction.connectionId),
          ))
          .limit(1)
          .for("update")
        if (accounts[0]?.pendingCodeVerifier === transaction.codeVerifier) {
          await tx.update(ConnectedAccountTable)
            .set({ pendingCodeVerifier: null })
            .where(eq(ConnectedAccountTable.id, accounts[0].id))
        }
      }
    }

    // Rows written by a pre-transaction-table replica have no durable expiry
    // beyond their owning row's update time. Once older than the fixed OAuth
    // transaction TTL they cannot be a live authorization, whether they are
    // a raw verifier or the previous enterprise JSON envelope.
    let remaining = limit - expiredTransactions.length
    let legacyCleared = 0
    if (remaining > 0) {
      const cutoff = new Date(now.getTime() - EXTERNAL_MCP_OAUTH_TRANSACTION_TTL_MS)
      const staleConnections = await tx
        .select({ id: ExternalMcpConnectionTable.id })
        .from(ExternalMcpConnectionTable)
        .where(and(
          isNotNull(ExternalMcpConnectionTable.pendingCodeVerifier),
          lte(ExternalMcpConnectionTable.updatedAt, cutoff),
        ))
        .orderBy(ExternalMcpConnectionTable.updatedAt, ExternalMcpConnectionTable.id)
        .limit(remaining)
        .for("update")
      if (staleConnections.length > 0) {
        await tx.update(ExternalMcpConnectionTable)
          .set({ pendingCodeVerifier: null })
          .where(inArray(ExternalMcpConnectionTable.id, staleConnections.map((row) => row.id)))
      }
      legacyCleared += staleConnections.length
      remaining -= staleConnections.length
      if (remaining > 0) {
        const staleAccounts = await tx
          .select({ id: ConnectedAccountTable.id })
          .from(ConnectedAccountTable)
          .where(and(
            isNotNull(ConnectedAccountTable.pendingCodeVerifier),
            lte(ConnectedAccountTable.updatedAt, cutoff),
          ))
          .orderBy(ConnectedAccountTable.updatedAt, ConnectedAccountTable.id)
          .limit(remaining)
          .for("update")
        if (staleAccounts.length > 0) {
          await tx.update(ConnectedAccountTable)
            .set({ pendingCodeVerifier: null })
            .where(inArray(ConnectedAccountTable.id, staleAccounts.map((row) => row.id)))
        }
        legacyCleared += staleAccounts.length
      }
    }

    return {
      deleted: expiredTransactions.length,
      limitReached: expiredTransactions.length + legacyCleared === limit,
    }
  })
}

/**
 * OAuth state is signed but still bearer data. Persist only a fixed-length,
 * one-way lookup key so a database read cannot disclose a live callback URL.
 */
export function externalMcpOAuthStateKey(signedState: string): string {
  return createHash("sha256").update(signedState).digest("hex")
}

export async function saveExternalMcpOAuthTransaction(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  authorizationActor: ExternalMcpAuthorizationActor
  expectedAuthorizationEpoch: number
  expectedIdentityBinding: string
  signedState: string
  codeVerifier: string
  clientRegistrationRevision?: string
  expiresAt?: Date
  assertActive?: () => void
}): Promise<void> {
  const now = new Date()
  const stateKey = externalMcpOAuthStateKey(input.signedState)
  await db.transaction(async (tx) => {
    input.assertActive?.()
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) throw new Error("The external MCP connection no longer exists.")
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch) {
      throw new Error("The MCP connection was disconnected while authorization was starting.")
    }
    await assertExternalMcpOAuthAuthorizationActorForCommit({
      tx,
      connection,
      authorizationActor: input.authorizationActor,
    })
    if (
      connection.credentialMode === "per_member"
      && input.authorizationActor.orgMembershipId !== input.orgMembershipId
    ) {
      oauthAuthorizationRevoked()
    }

    // Keep cleanup work bounded even if an old deployment accumulated a large
    // backlog. The connection row lock serializes starts for this connection;
    // row locks here also give concurrent callback consumption one ordering.
    const expiredTransactions = await tx
      .select({ stateKey: ExternalMcpOAuthTransactionTable.stateKey })
      .from(ExternalMcpOAuthTransactionTable)
      .where(and(
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
        lte(ExternalMcpOAuthTransactionTable.expiresAt, now),
      ))
      .orderBy(
        ExternalMcpOAuthTransactionTable.expiresAt,
        ExternalMcpOAuthTransactionTable.stateKey,
      )
      .limit(MAX_EXTERNAL_MCP_EXPIRED_OAUTH_TRANSACTION_CLEANUP)
      .for("update")
    if (expiredTransactions.length > 0) {
      await tx.delete(ExternalMcpOAuthTransactionTable).where(inArray(
        ExternalMcpOAuthTransactionTable.stateKey,
        expiredTransactions.map((transaction) => transaction.stateKey),
      ))
    }

    const pendingTransactions = await tx
      .select({ stateKey: ExternalMcpOAuthTransactionTable.stateKey })
      .from(ExternalMcpOAuthTransactionTable)
      .where(and(
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
        eq(ExternalMcpOAuthTransactionTable.orgMembershipId, input.orgMembershipId),
        gt(ExternalMcpOAuthTransactionTable.expiresAt, now),
      ))
      .limit(MAX_EXTERNAL_MCP_PENDING_OAUTH_TRANSACTIONS_PER_MEMBER)
      .for("update")
    if (pendingTransactions.length >= MAX_EXTERNAL_MCP_PENDING_OAUTH_TRANSACTIONS_PER_MEMBER) {
      throw new Error(
        `At most ${MAX_EXTERNAL_MCP_PENDING_OAUTH_TRANSACTIONS_PER_MEMBER} pending OAuth authorizations are allowed per connection identity.`,
      )
    }

    // Expand-release bridge for callbacks that still land on an old replica.
    // Old code has one slot, so only the latest start is compatible there;
    // state-keyed rows remain authoritative on new replicas.
    if (connection.credentialMode === "per_member") {
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
      if (account) {
        await tx
          .update(ConnectedAccountTable)
          .set({ pendingCodeVerifier: input.codeVerifier })
          .where(eq(ConnectedAccountTable.id, account.id))
      } else {
        await tx.insert(ConnectedAccountTable).values({
          id: createDenTypeId("connectedAccount"),
          organizationId: input.organizationId,
          orgMembershipId: input.orgMembershipId,
          providerId: input.connectionId,
          pendingCodeVerifier: input.codeVerifier,
        })
      }
    } else {
      await tx
        .update(ExternalMcpConnectionTable)
        .set({ pendingCodeVerifier: input.codeVerifier })
        .where(eq(ExternalMcpConnectionTable.id, connection.id))
    }

    await tx.insert(ExternalMcpOAuthTransactionTable).values({
      stateKey,
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      orgMembershipId: input.orgMembershipId,
      connectionAuthorizationEpoch: connection.oauthAuthorizationEpoch,
      clientRegistrationRevision: input.clientRegistrationRevision ?? null,
      codeVerifier: input.codeVerifier,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + EXTERNAL_MCP_OAUTH_TRANSACTION_TTL_MS),
    })
    input.assertActive?.()
  })
}

/**
 * Reads and deletes one verifier under the same row lock. A concurrent or
 * replayed callback therefore observes no transaction and cannot exchange a
 * second authorization code with the same state.
 */
export async function consumeExternalMcpOAuthTransaction(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  expectedIdentityBinding: string
  signedState: string
  now?: Date
}): Promise<{
  codeVerifier: string
  authorizationEpoch: number
  clientRegistrationRevision?: string
  expiresAt: Date
} | null> {
  const stateKey = externalMcpOAuthStateKey(input.signedState)
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return null
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }

    const rows = await tx
      .select()
      .from(ExternalMcpOAuthTransactionTable)
      .where(and(
        eq(ExternalMcpOAuthTransactionTable.stateKey, stateKey),
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
        eq(ExternalMcpOAuthTransactionTable.orgMembershipId, input.orgMembershipId),
      ))
      .limit(1)
      .for("update")
    const transaction = rows[0]
    if (!transaction) return null
    await tx.delete(ExternalMcpOAuthTransactionTable).where(
      eq(ExternalMcpOAuthTransactionTable.stateKey, stateKey),
    )
    return transaction.expiresAt > now
      ? {
          codeVerifier: transaction.codeVerifier,
          authorizationEpoch: transaction.connectionAuthorizationEpoch,
          expiresAt: transaction.expiresAt,
          ...(transaction.clientRegistrationRevision
            ? { clientRegistrationRevision: transaction.clientRegistrationRevision }
            : {}),
        }
      : null
  })
}

const LEGACY_PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

/**
 * Expand-phase compatibility for an authorization started by a pre-migration
 * Den replica. Legacy rows cannot bind a verifier to state, so this path is
 * used only when the exact state-keyed transaction is absent. The row lock
 * and clear make even that fallback single-use.
 */
export async function consumeLegacyExternalMcpPendingCodeVerifier(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  expectedIdentityBinding: string
}): Promise<string | null> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return null
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }

    const activeMembers = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, input.orgMembershipId),
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1)
      .for("update")
    if (!activeMembers[0]) return null

    if (connection.credentialMode === "per_member") {
      const accountRows = await tx
        .select({
          id: ConnectedAccountTable.id,
          pendingCodeVerifier: ConnectedAccountTable.pendingCodeVerifier,
        })
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        ))
        .limit(1)
        .for("update")
      const account = accountRows[0]
      const verifier = account?.pendingCodeVerifier
      if (!account || !verifier || !LEGACY_PKCE_CODE_VERIFIER_PATTERN.test(verifier)) return null
      await tx
        .update(ConnectedAccountTable)
        .set({ pendingCodeVerifier: null })
        .where(eq(ConnectedAccountTable.id, account.id))
      return verifier
    }

    const verifier = connection.pendingCodeVerifier
    if (!verifier || !LEGACY_PKCE_CODE_VERIFIER_PATTERN.test(verifier)) return null
    await tx
      .update(ExternalMcpConnectionTable)
      .set({ pendingCodeVerifier: null })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
    return verifier
  })
}

/**
 * Best-effort compare-and-clear for the expand-release dual-write slot. The
 * encrypted value is compared in memory under a row lock; a newer tab's
 * verifier is never erased by an older callback.
 */
export async function clearLegacyExternalMcpPendingCodeVerifierIfMatches(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  expectedCodeVerifier: string
  expectedIdentityBinding: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return false
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }

    if (connection.credentialMode === "per_member") {
      const accountRows = await tx
        .select({
          id: ConnectedAccountTable.id,
          pendingCodeVerifier: ConnectedAccountTable.pendingCodeVerifier,
        })
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        ))
        .limit(1)
        .for("update")
      const account = accountRows[0]
      if (!account || account.pendingCodeVerifier !== input.expectedCodeVerifier) return false
      await tx
        .update(ConnectedAccountTable)
        .set({ pendingCodeVerifier: null })
        .where(eq(ConnectedAccountTable.id, account.id))
      return true
    }

    if (connection.pendingCodeVerifier !== input.expectedCodeVerifier) return false
    await tx
      .update(ExternalMcpConnectionTable)
      .set({ pendingCodeVerifier: null })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
    return true
  })
}

/** Remove exactly one abandoned authorization without disturbing other tabs. */
export async function deleteExternalMcpOAuthTransaction(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  expectedIdentityBinding: string
  signedState: string
}): Promise<string | null> {
  const stateKey = externalMcpOAuthStateKey(input.signedState)
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return null
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }

    const rows = await tx
      .select({ codeVerifier: ExternalMcpOAuthTransactionTable.codeVerifier })
      .from(ExternalMcpOAuthTransactionTable)
      .where(and(
        eq(ExternalMcpOAuthTransactionTable.stateKey, stateKey),
        eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
        eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
        eq(ExternalMcpOAuthTransactionTable.orgMembershipId, input.orgMembershipId),
      ))
      .limit(1)
      .for("update")
    const transaction = rows[0]
    if (!transaction) return null
    await tx.delete(ExternalMcpOAuthTransactionTable).where(
      eq(ExternalMcpOAuthTransactionTable.stateKey, stateKey),
    )
    return transaction.codeVerifier
  })
}

export async function deleteExternalMcpOAuthTransactionsForConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<void> {
  await db.delete(ExternalMcpOAuthTransactionTable).where(and(
    eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
    eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
  ))
}

/**
 * Change one external-MCP OAuth client only while both its owning connection
 * and the exact client revision observed by the caller are still current.
 *
 * Connection deletion/disconnect and client persistence share the connection
 * row lock, so a late async writer cannot recreate credentials after either
 * authority boundary moves. Returning the post-write revision from inside the
 * transaction lets multi-step callers perform a later rollback without a
 * separate read that could accidentally capture an administrator's rotation.
 * `createdByOrgMembershipId` is used for inserts; updates preserve the
 * original creator, matching the existing org OAuth client update semantics.
 * Import sagas can additionally require an exact connection snapshot with no
 * dependent binding, grant, account, or OAuth transaction before installing
 * their first client.
 */
export async function compareAndSetExternalMcpOAuthClient(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  expectedIdentityBinding?: string
  expectedAuthorizationEpoch?: number
  expectedConnection?: ExternalMcpConnectionRow
  requireNoDependentState?: boolean
  authorizationActor?: ExternalMcpAuthorizationActor
  expected: ExternalMcpOAuthClientRevision | null
  next: ExternalMcpOAuthClientValue | null
}): Promise<ExternalMcpOAuthClientCasResult> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return { status: "connection_missing" }
    if (
      input.expectedIdentityBinding !== undefined
      && !externalMcpIdentityMatches(connection, input.expectedIdentityBinding)
    ) return { status: "connection_changed" }
    if (
      input.expectedAuthorizationEpoch !== undefined
      && connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch
    ) return { status: "connection_changed" }
    if (input.expectedConnection && !sameExternalMcpConnectionSnapshot(connection, input.expectedConnection)) {
      return { status: "connection_changed" }
    }
    if (input.authorizationActor) {
      await assertExternalMcpOAuthAuthorizationActorForCommit({
        tx,
        connection,
        authorizationActor: input.authorizationActor,
      })
    }
    if (input.requireNoDependentState) {
      const bindings = await tx.select({ id: PluginMcpRequirementBindingTable.id })
        .from(PluginMcpRequirementBindingTable)
        .where(and(
          eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
          eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connectionId),
        )).limit(1).for("update")
      const access = await tx.select({ id: ExternalMcpConnectionAccessGrantTable.id })
        .from(ExternalMcpConnectionAccessGrantTable)
        .where(and(
          eq(ExternalMcpConnectionAccessGrantTable.organizationId, input.organizationId),
          eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId),
        )).limit(1).for("update")
      const accounts = await tx.select({ id: ConnectedAccountTable.id })
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        )).limit(1).for("update")
      const transactions = await tx.select({ stateKey: ExternalMcpOAuthTransactionTable.stateKey })
        .from(ExternalMcpOAuthTransactionTable)
        .where(and(
          eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
          eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, input.connectionId),
        )).limit(1).for("update")
      if (bindings[0] || access[0] || accounts[0] || transactions[0]) {
        return { status: "connection_changed" }
      }
    }

    const clientRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const client = clientRows[0]
    if (
      (input.expected === null && client !== undefined)
      || (input.expected !== null && client === undefined)
      || (
        input.expected !== null
        && client !== undefined
        && !sameExternalMcpOAuthClientRevision(client, input.expected)
      )
    ) return { status: "client_changed" }

    if (!input.next) {
      if (client) {
        await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.id, client.id))
      }
      return { status: "applied", revision: null }
    }

    let clientId = client?.id
    if (client) {
      await tx
        .update(OrgOAuthClientTable)
        .set({
          clientId: input.next.clientId,
          clientSecret: input.next.clientSecret,
          extra: input.next.extra,
        })
        .where(eq(OrgOAuthClientTable.id, client.id))
    } else {
      clientId = createDenTypeId("orgOAuthClient")
      await tx.insert(OrgOAuthClientTable).values({
        id: clientId,
        organizationId: input.organizationId,
        providerId: input.connectionId,
        clientId: input.next.clientId,
        clientSecret: input.next.clientSecret,
        extra: input.next.extra,
        createdByOrgMembershipId: input.next.createdByOrgMembershipId,
      })
    }

    const persistedRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(eq(OrgOAuthClientTable.id, clientId!))
      .limit(1)
    const persisted = persistedRows[0]
    if (!persisted) throw new Error("The OAuth client disappeared before its write could commit.")
    return { status: "applied", revision: externalMcpOAuthClientRevision(persisted) }
  })
}

export type ExternalMcpOAuthRegistrationLeaseResult = "acquired" | "busy" | "connection_changed" | "connection_missing"

/**
 * Claim the connection row as the sole DCR writer. A crashed replica's lease
 * becomes claimable after `staleBefore`; a live lease cannot be stolen.
 */
export async function tryAcquireExternalMcpOAuthRegistrationLease(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  leaseToken: string
  startedAt: Date
  staleBefore: Date
  expectedIdentityBinding: string
  expectedAuthorizationEpoch: number
  authorizationActor: ExternalMcpAuthorizationActor
  assertActive?: () => void
}): Promise<ExternalMcpOAuthRegistrationLeaseResult> {
  return db.transaction(async (tx) => {
    input.assertActive?.()
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
    if (!connection) return "connection_missing"
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch) return "connection_changed"
    await assertExternalMcpOAuthAuthorizationActorForCommit({
      tx,
      connection,
      authorizationActor: input.authorizationActor,
    })
    if (
      connection.oauthRegistrationLeaseToken
      && connection.oauthRegistrationLeaseToken !== input.leaseToken
      && connection.oauthRegistrationLeaseStartedAt
      && connection.oauthRegistrationLeaseStartedAt >= input.staleBefore
    ) return "busy"

    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        oauthRegistrationLeaseToken: input.leaseToken,
        oauthRegistrationLeaseStartedAt: input.startedAt,
      })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
    input.assertActive?.()
    return "acquired"
  })
}

export async function releaseExternalMcpOAuthRegistrationLease(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  leaseToken: string
  expectedIdentityBinding: string
}): Promise<void> {
  await db.transaction(async (tx) => {
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
    if (!connection) return
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.oauthRegistrationLeaseToken !== input.leaseToken) return
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        oauthRegistrationLeaseToken: null,
        oauthRegistrationLeaseStartedAt: null,
      })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
  })
}

/**
 * The DCR response and lease release commit together. The insert is rejected
 * if this worker lost the lease or another client appeared while it was
 * talking to the registration endpoint.
 */
export async function persistExternalMcpDcrOAuthClientWithLease(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  leaseToken: string
  expectedAuthorizationEpoch: number
  expectedIdentityBinding: string
  authorizationActor: ExternalMcpAuthorizationActor
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown>
  assertActive?: () => void
}): Promise<ExternalMcpOAuthClientRevision> {
  return db.transaction(async (tx) => {
    input.assertActive?.()
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) throw new Error("The external MCP connection no longer exists.")
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch) {
      throw new Error("The external MCP connection was disconnected while OAuth client registration was in progress.")
    }
    if (connection.oauthRegistrationLeaseToken !== input.leaseToken) {
      throw new Error("The dynamic OAuth client registration lease is no longer owned by this request.")
    }
    await assertExternalMcpOAuthAuthorizationActorForCommit({
      tx,
      connection,
      authorizationActor: input.authorizationActor,
    })

    const existingClients = await tx
      .select({ id: OrgOAuthClientTable.id })
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    if (existingClients[0]) {
      throw new Error("An OAuth client was configured while dynamic registration was in progress. Start authorization again with the saved client.")
    }

    const clientRowId = createDenTypeId("orgOAuthClient")
    await tx.insert(OrgOAuthClientTable).values({
      id: clientRowId,
      organizationId: input.organizationId,
      providerId: input.connectionId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      extra: input.extra,
      createdByOrgMembershipId: input.authorizationActor.orgMembershipId,
    })
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        oauthRegistrationLeaseToken: null,
        oauthRegistrationLeaseStartedAt: null,
      })
      .where(and(
        eq(ExternalMcpConnectionTable.id, connection.id),
        eq(ExternalMcpConnectionTable.oauthRegistrationLeaseToken, input.leaseToken),
      ))
    const persistedRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(eq(OrgOAuthClientTable.id, clientRowId))
      .limit(1)
    const persisted = persistedRows[0]
    if (!persisted) throw new Error("The dynamically registered OAuth client was not persisted.")
    input.assertActive?.()
    return externalMcpOAuthClientRevision(persisted)
  })
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
  expectedRevision: ExternalMcpTokenRevision
  expectedIdentityBinding: string
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
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(existing, input.expectedIdentityBinding)
    }
    if (externalMcpSharedTokenRevision(existing) !== input.expectedRevision) return false
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
      .where(eq(ExternalMcpConnectionTable.id, existing.id))
    return true
  })
}

/** Update-only per-member cleanup; never recreate an account after delete. */
export async function clearExternalMcpMemberTokens(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  expectedRevision: ExternalMcpTokenRevision
  expectedIdentityBinding: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) return false
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    const accountRows = await tx
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const account = accountRows[0]
    if (!account || externalMcpMemberTokenRevision(account) !== input.expectedRevision) return false
    await tx
      .update(ConnectedAccountTable)
      .set({
        accessToken: null,
        refreshToken: null,
        tokenType: null,
        scopes: null,
        expiresAt: null,
      })
      .where(eq(ConnectedAccountTable.id, account.id))
    return true
  })
}

/**
 * Adopt publisher-declared fallback scopes onto a pre-migration OAuth row.
 * Existing tokens were authorized without a durable record of that fallback,
 * so clear both shared and per-member grants and require explicit re-consent.
 * This avoids creating a duplicate connection while never silently widening a
 * deployed user's authorization.
 */
export async function adoptLegacyExternalMcpRequestedOAuthScopes(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  requestedOAuthScopes: readonly string[]
  expectedIdentityBinding: string
}): Promise<ExternalMcpConnectionRow | null> {
  const requestedOAuthScopes = normalizeExternalMcpRequestedOAuthScopes(input.requestedOAuthScopes)
  if (!requestedOAuthScopes?.length) return getExternalMcpConnection(input)
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
    if (!existing || existing.authType !== "oauth") return null
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(existing, input.expectedIdentityBinding)
    }
    if (existing.requestedOAuthScopes?.length) {
      return externalMcpRequestedOAuthScopeSetsMatch(existing.requestedOAuthScopes, requestedOAuthScopes)
        ? existing
        : null
    }

    const clientRows = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, existing.id),
      ))
      .limit(1)
      .for("update")
    const client = clientRows[0]
    if (client && storedExternalMcpOAuthClientProvenance(client.extra) === "dcr") {
      // DCR metadata includes the requested scope set. Rotate only dynamic
      // registrations; pre-registered clients and CIMD documents are owned
      // outside OpenWork and remain valid across a local scope preference.
      await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.id, client.id))
    }

    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        accessToken: null,
        connectedAt: null,
        expiresAt: null,
        pendingCodeVerifier: null,
        refreshToken: null,
        requestedOAuthScopes,
        scope: null,
        tokenType: null,
        oauthRegistrationLeaseToken: null,
        oauthRegistrationLeaseStartedAt: null,
        oauthAuthorizationEpoch: sql`${ExternalMcpConnectionTable.oauthAuthorizationEpoch} + 1`,
      })
      .where(eq(ExternalMcpConnectionTable.id, existing.id))
    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
      eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, existing.id),
    ))
    return {
      ...existing,
      accessToken: null,
      connectedAt: null,
      expiresAt: null,
      pendingCodeVerifier: null,
      refreshToken: null,
      requestedOAuthScopes,
      scope: null,
      tokenType: null,
      oauthRegistrationLeaseToken: null,
      oauthRegistrationLeaseStartedAt: null,
      oauthAuthorizationEpoch: existing.oauthAuthorizationEpoch + 1,
    }
  })
}

type ExternalMcpTokenCommit = {
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
  assertActive?: () => void
}

/**
 * Commits an authorization-code result only while the initiating actor still
 * has authority. The live connection, actor, assignment, and target account
 * are locked in the same transaction as the encrypted credential write.
 */
export async function saveExternalMcpAuthorizationCodeTokens(input: ExternalMcpTokenCommit & {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  authorizationActor: ExternalMcpAuthorizationActor
  expectedAuthorizationEpoch: number
  expectedIdentityBinding: string
  orgMembershipId?: OrgMembershipId
}): Promise<ExternalMcpTokenRevision> {
  return db.transaction(async (tx) => {
    input.assertActive?.()
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) throw new Error("The external MCP connection no longer exists.")
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.authType !== "oauth") throw new Error("The external MCP connection is not configured for OAuth.")
    if (connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch) {
      throw new Error("The MCP connection was disconnected before OAuth credentials could be saved.")
    }
    await assertExternalMcpOAuthAuthorizationActorForCommit({
      tx,
      connection,
      authorizationActor: input.authorizationActor,
    })

    if (connection.credentialMode === "per_member") {
      if (
        !input.orgMembershipId
        || input.orgMembershipId !== input.authorizationActor.orgMembershipId
      ) oauthAuthorizationRevoked()
      const accountRows = await tx
        .select()
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        ))
        .limit(1)
        .for("update")
      const account = accountRows[0]
      // A start always creates the pending account row. Its absence means a
      // disconnect/member-removal won while the provider exchanged the code.
      if (!account) throw new Error("The MCP OAuth account was disconnected before credentials could be saved.")
      await tx
        .update(ConnectedAccountTable)
        .set({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? account.refreshToken ?? null,
          tokenType: input.tokenType ?? null,
          scopes: input.scope !== undefined
            ? input.scope?.split(/\s+/).filter(Boolean) ?? null
            : account.scopes,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        })
        .where(eq(ConnectedAccountTable.id, account.id))
      const persistedRows = await tx
        .select()
        .from(ConnectedAccountTable)
        .where(eq(ConnectedAccountTable.id, account.id))
        .limit(1)
      const persisted = persistedRows[0]
      if (!persisted) throw new Error("The MCP OAuth account disappeared before credentials could commit.")
      input.assertActive?.()
      return externalMcpMemberTokenRevision(persisted)
    }

    if (input.orgMembershipId) oauthAuthorizationRevoked()
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? connection.refreshToken ?? null,
        tokenType: input.tokenType ?? null,
        scope: input.scope !== undefined ? input.scope : connection.scope,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        connectedAt: new Date(),
      })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
    const persistedRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    const persisted = persistedRows[0]
    if (!persisted) throw new Error("The external MCP connection disappeared before credentials could commit.")
    input.assertActive?.()
    return externalMcpSharedTokenRevision(persisted)
  })
}

/**
 * Refreshes do not have a browser authorization actor. They still lock and
 * require the live connection/account and the disconnect fence so a late
 * provider response cannot recreate credentials after revocation.
 */
export async function saveExternalMcpRefreshTokens(input: ExternalMcpTokenCommit & {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  expectedAuthorizationEpoch: number
  expectedIdentityBinding: string
  orgMembershipId?: OrgMembershipId
}): Promise<ExternalMcpTokenRevision> {
  return db.transaction(async (tx) => {
    input.assertActive?.()
    const connectionRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = connectionRows[0]
    if (!connection) throw new Error("The external MCP connection no longer exists.")
    if (input.expectedIdentityBinding !== undefined) {
      assertExternalMcpIdentityBinding(connection, input.expectedIdentityBinding)
    }
    if (connection.oauthAuthorizationEpoch !== input.expectedAuthorizationEpoch) {
      throw new Error("The MCP connection was disconnected before refreshed credentials could be saved.")
    }

    if (connection.credentialMode === "per_member") {
      if (!input.orgMembershipId) throw new Error("A per-member MCP refresh requires its member context.")
      const accountRows = await tx
        .select()
        .from(ConnectedAccountTable)
        .where(and(
          eq(ConnectedAccountTable.organizationId, input.organizationId),
          eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
          eq(ConnectedAccountTable.providerId, input.connectionId),
        ))
        .limit(1)
        .for("update")
      const account = accountRows[0]
      if (!account) throw new Error("The per-member MCP account was disconnected before refreshed credentials could be saved.")
      await tx
        .update(ConnectedAccountTable)
        .set({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? account.refreshToken ?? null,
          tokenType: input.tokenType ?? null,
          scopes: input.scope !== undefined
            ? input.scope?.split(/\s+/).filter(Boolean) ?? null
            : account.scopes,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        })
        .where(eq(ConnectedAccountTable.id, account.id))
      const persistedRows = await tx
        .select()
        .from(ConnectedAccountTable)
        .where(eq(ConnectedAccountTable.id, account.id))
        .limit(1)
      const persisted = persistedRows[0]
      if (!persisted) throw new Error("The per-member MCP account disappeared before refreshed credentials could commit.")
      input.assertActive?.()
      return externalMcpMemberTokenRevision(persisted)
    }

    if (input.orgMembershipId) throw new Error("A shared MCP refresh cannot target a member account.")
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? connection.refreshToken ?? null,
        tokenType: input.tokenType ?? null,
        scope: input.scope !== undefined ? input.scope : connection.scope,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        connectedAt: new Date(),
      })
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
    const persistedRows = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    const persisted = persistedRows[0]
    if (!persisted) throw new Error("The external MCP connection disappeared before refreshed credentials could commit.")
    input.assertActive?.()
    return externalMcpSharedTokenRevision(persisted)
  })
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

    // Incrementing the fence invalidates a callback or refresh that already
    // consumed its PKCE transaction and is waiting on the provider. Clearing
    // the DCR lease also prevents a stale start from committing registration
    // state after this disconnect.
    await tx
      .update(ExternalMcpConnectionTable)
      .set({
        accessToken: null,
        refreshToken: null,
        tokenType: null,
        scope: null,
        expiresAt: null,
        connectedAt: null,
        pendingCodeVerifier: null,
        oauthRegistrationLeaseToken: null,
        oauthRegistrationLeaseStartedAt: null,
        oauthAuthorizationEpoch: sql`${ExternalMcpConnectionTable.oauthAuthorizationEpoch} + 1`,
      })
      .where(eq(ExternalMcpConnectionTable.id, existing.id))
    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
      eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, existing.id),
    ))
    return true
  })
}

export type ExternalMcpMemberDisconnectResult = "disconnected" | "connection_not_found" | "not_per_member"

/**
 * Revoke only one member's external MCP account. The connection row is the
 * common lock taken by OAuth starts, callback commits, refreshes, and the
 * administrator-wide disconnect, so each concurrent operation has one clear
 * ordering. Deleting the member account also fences update-only callback and
 * refresh commits without invalidating another member's authorization epoch.
 */
export async function disconnectExternalMcpMemberAccount(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
}): Promise<ExternalMcpMemberDisconnectResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: ExternalMcpConnectionTable.id,
        credentialMode: ExternalMcpConnectionTable.credentialMode,
      })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const connection = rows[0]
    if (!connection) return "connection_not_found"
    if (connection.credentialMode !== "per_member") return "not_per_member"

    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
      eq(ConnectedAccountTable.providerId, connection.id),
    ))
    await tx.delete(ExternalMcpOAuthTransactionTable).where(and(
      eq(ExternalMcpOAuthTransactionTable.organizationId, input.organizationId),
      eq(ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
      eq(ExternalMcpOAuthTransactionTable.orgMembershipId, input.orgMembershipId),
    ))
    return "disconnected"
  })
}
