import { and, asc, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  ConnectorAccountTable,
  ConnectorInstanceAccessGrantTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSourceBindingTable,
  ConnectorSourceTombstoneTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  MemberTable,
  OrganizationTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext, PluginArchResourceKind, PluginArchRole } from "./access.js"
import { requirePluginArchResourceRole, resolvePluginArchResourceRole } from "./access.js"
import {
  buildGithubAppInstallUrl,
  createGithubInstallStateToken,
  GithubConnectorConfigError,
  GithubConnectorRequestError,
  getGithubAppSummary,
  getGithubConnectorAppConfig,
  getGithubRepositoryTextFile,
  getGithubRepositoryTree,
  getGithubInstallationSummary,
  listGithubInstallationRepositories,
  validateGithubInstallationTarget,
  verifyGithubInstallStateToken,
} from "./github-app.js"
import {
  buildGithubRepoDiscovery,
  type GithubDiscoveredPlugin,
  type GithubDiscoveryClassification,
  type GithubDiscoveryTreeEntry,
} from "./github-discovery.js"
import { db } from "../../../db.js"
import { env } from "../../../env.js"
import { roleIncludesOwner } from "../../../orgs.js"

type OrganizationId = PluginArchActorContext["organizationContext"]["organization"]["id"]
type MemberId = PluginArchActorContext["organizationContext"]["currentMember"]["id"]
type TeamId = PluginArchActorContext["memberTeams"][number]["id"]
type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
type MarketplaceRow = typeof MarketplaceTable.$inferSelect
type MarketplaceMembershipRow = typeof MarketplacePluginTable.$inferSelect
type PluginRow = typeof PluginTable.$inferSelect
type PluginMembershipRow = typeof PluginConfigObjectTable.$inferSelect
type ConfigObjectId = ConfigObjectRow["id"]
type ConfigObjectVersionId = ConfigObjectVersionRow["id"]
type MarketplaceId = MarketplaceRow["id"]
type MarketplaceMembershipId = MarketplaceMembershipRow["id"]
type PluginId = PluginRow["id"]
type PluginMembershipId = PluginMembershipRow["id"]
type AccessGrantRow =
  | typeof ConfigObjectAccessGrantTable.$inferSelect
  | typeof MarketplaceAccessGrantTable.$inferSelect
  | typeof PluginAccessGrantTable.$inferSelect
  | typeof ConnectorInstanceAccessGrantTable.$inferSelect
type ConfigObjectAccessGrantId = typeof ConfigObjectAccessGrantTable.$inferSelect.id
type MarketplaceAccessGrantId = typeof MarketplaceAccessGrantTable.$inferSelect.id
type PluginAccessGrantId = typeof PluginAccessGrantTable.$inferSelect.id
type ConnectorInstanceAccessGrantId = typeof ConnectorInstanceAccessGrantTable.$inferSelect.id
type ConnectorAccountRow = typeof ConnectorAccountTable.$inferSelect
type ConnectorInstanceRow = typeof ConnectorInstanceTable.$inferSelect
type ConnectorTargetRow = typeof ConnectorTargetTable.$inferSelect
type ConnectorMappingRow = typeof ConnectorMappingTable.$inferSelect
type ConnectorSyncEventRow = typeof ConnectorSyncEventTable.$inferSelect
type ConnectorAccountId = ConnectorAccountRow["id"]
type ConnectorInstanceId = ConnectorInstanceRow["id"]
type ConnectorTargetId = ConnectorTargetRow["id"]
type ConnectorMappingId = ConnectorMappingRow["id"]
type ConnectorSyncEventId = ConnectorSyncEventRow["id"]
type MemberRow = typeof MemberTable.$inferSelect
type OrganizationRow = typeof OrganizationTable.$inferSelect

type CursorPage<TItem extends { id: string }> = {
  items: TItem[]
  nextCursor: string | null
}

type GithubConnectorDiscoveryStep = {
  id: "read_repository_structure" | "check_marketplace_manifest" | "check_plugin_manifests" | "prepare_discovered_plugins"
  label: string
  status: "completed" | "running" | "warning"
}

type GithubConnectorDiscoveryTreeSummary = {
  scannedEntryCount: number
  strategy: "git-tree-recursive"
  truncated: boolean
}

type ConfigObjectInput = {
  metadata?: Record<string, unknown>
  normalizedPayloadJson?: Record<string, unknown>
  parserMode?: string
  rawSourceText?: string
  schemaVersion?: string
}

type AccessGrantWrite = {
  orgMembershipId?: MemberId
  orgWide?: boolean
  role: PluginArchRole
  teamId?: TeamId
}

type RepositorySummary = {
  defaultBranch: string | null
  fullName: string
  hasPluginManifest?: boolean
  id: number
  manifestKind?: "marketplace" | "plugin" | null
  marketplacePluginCount?: number | null
  private: boolean
}

type ConfigObjectResourceTarget = {
  resourceId: ConfigObjectId
  resourceKind: "config_object"
}

type PluginResourceTarget = {
  resourceId: PluginId
  resourceKind: "plugin"
}

type MarketplaceResourceTarget = {
  resourceId: MarketplaceId
  resourceKind: "marketplace"
}

type ConnectorInstanceResourceTarget = {
  resourceId: ConnectorInstanceId
  resourceKind: "connector_instance"
}

type ResourceTarget =
  | ConfigObjectResourceTarget
  | MarketplaceResourceTarget
  | PluginResourceTarget
  | ConnectorInstanceResourceTarget

type ConfigObjectGrantTarget = ConfigObjectResourceTarget & { grantId: ConfigObjectAccessGrantId }
type MarketplaceGrantTarget = MarketplaceResourceTarget & { grantId: MarketplaceAccessGrantId }
type PluginGrantTarget = PluginResourceTarget & { grantId: PluginAccessGrantId }
type ConnectorInstanceGrantTarget = ConnectorInstanceResourceTarget & { grantId: ConnectorInstanceAccessGrantId }
type GrantTarget = ConfigObjectGrantTarget | MarketplaceGrantTarget | PluginGrantTarget | ConnectorInstanceGrantTarget

export class PluginArchRouteFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly error: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginArchRouteFailure"
  }
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function firstTextLine(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? ""
}

function stripLineDecorators(value: string) {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim()
}

function deriveProjection(input: { objectType: ConfigObjectRow["objectType"]; value: ConfigObjectInput }) {
  const metadata = input.value.metadata ?? {}
  const payload = input.value.normalizedPayloadJson ?? {}
  const rawSourceText = normalizeOptionalString(input.value.rawSourceText)
  const titleCandidate = [
    typeof metadata.title === "string" ? metadata.title : null,
    typeof metadata.name === "string" ? metadata.name : null,
    typeof payload.title === "string" ? payload.title : null,
    typeof payload.name === "string" ? payload.name : null,
    rawSourceText ? stripLineDecorators(firstTextLine(rawSourceText)) : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const descriptionCandidate = [
    typeof metadata.description === "string" ? metadata.description : null,
    typeof payload.description === "string" ? payload.description : null,
    rawSourceText
      ? rawSourceText
        .split(/\r?\n/g)
        .map((line) => stripLineDecorators(line.trim()))
        .filter(Boolean)
        .slice(1)
        .find(Boolean) ?? null
      : null,
  ].find((value) => Boolean(normalizeOptionalString(value ?? undefined)))

  const title = normalizeOptionalString(titleCandidate ?? undefined)
    ?? `${input.objectType.charAt(0).toUpperCase()}${input.objectType.slice(1)} ${new Date().toISOString()}`

  const description = normalizeOptionalString(descriptionCandidate ?? undefined)
  const searchText = [title, description, rawSourceText].filter(Boolean).join("\n") || null

  return {
    description,
    searchText,
    title,
  }
}

function pageItems<TItem extends { id: string }>(items: TItem[], cursor: string | undefined, limit: number | undefined): CursorPage<TItem> {
  const ordered = [...items]
  const pageSize = limit ?? 50
  const startIndex = cursor ? Math.max(ordered.findIndex((item) => item.id === cursor) + 1, 0) : 0
  const sliced = ordered.slice(startIndex, startIndex + pageSize)
  const nextCursor = ordered.length > startIndex + pageSize ? sliced[sliced.length - 1]?.id ?? null : null
  return { items: sliced, nextCursor }
}

async function getLatestVersions(configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) {
    return new Map<string, ConfigObjectVersionRow>()
  }

  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))

  const latestByObjectId = new Map<string, ConfigObjectVersionRow>()
  for (const row of rows) {
    if (!latestByObjectId.has(row.configObjectId)) {
      latestByObjectId.set(row.configObjectId, row)
    }
  }

  return latestByObjectId
}

function serializeVersion(row: ConfigObjectVersionRow) {
  return {
    configObjectId: row.configObjectId,
    connectorSyncEventId: row.connectorSyncEventId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdVia: row.createdVia,
    id: row.id,
    isDeletedVersion: row.isDeletedVersion,
    normalizedPayloadJson: row.normalizedPayloadJson,
    rawSourceText: row.rawSourceText,
    schemaVersion: row.schemaVersion,
    sourceRevisionRef: row.sourceRevisionRef,
  }
}

function serializeConfigObject(row: ConfigObjectRow, latestVersion: ConfigObjectVersionRow | null) {
  return {
    connectorInstanceId: row.connectorInstanceId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    currentFileExtension: row.currentFileExtension,
    currentFileName: row.currentFileName,
    currentRelativePath: row.currentRelativePath,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    latestVersion: latestVersion ? serializeVersion(latestVersion) : null,
    objectType: row.objectType,
    organizationId: row.organizationId,
    searchText: row.searchText,
    sourceMode: row.sourceMode,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  }
}

type PluginMarketplaceSummary = {
  id: string
  name: string
}

function serializePlugin(row: PluginRow, memberCount?: number, marketplaces: PluginMarketplaceSummary[] = []) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    marketplaces,
    memberCount,
    name: row.name,
    organizationId: row.organizationId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMarketplace(row: MarketplaceRow, pluginCount?: number) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    pluginCount,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMembership(row: PluginMembershipRow, configObject?: ReturnType<typeof serializeConfigObject>) {
  return {
    configObject,
    configObjectId: row.configObjectId,
    connectorMappingId: row.connectorMappingId,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    membershipSource: row.membershipSource,
    pluginId: row.pluginId,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }
}

function serializeMarketplaceMembership(row: MarketplaceMembershipRow, plugin?: ReturnType<typeof serializePlugin>) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    marketplaceId: row.marketplaceId,
    membershipSource: row.membershipSource,
    plugin,
    pluginId: row.pluginId,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  }
}

function serializeAccessGrant(row: AccessGrantRow) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    orgMembershipId: row.orgMembershipId,
    orgWide: row.orgWide,
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    role: row.role,
    teamId: row.teamId,
  }
}

function serializeConnectorAccount(row: ConnectorAccountRow, creatorName: string | null = null) {
  return {
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByName: creatorName,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    displayName: row.displayName,
    externalAccountRef: row.externalAccountRef,
    id: row.id,
    metadata: row.metadataJson ?? undefined,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function resolveCreatorName(context: PluginArchActorContext, memberId: string) {
  const member = context.organizationContext.members.find((entry) => entry.id === memberId)
  if (!member) return null
  return member.user.name?.trim() || member.user.email || null
}

function serializeConnectorInstance(row: ConnectorInstanceRow) {
  return {
    connectorAccountId: row.connectorAccountId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    instanceConfigJson: row.instanceConfigJson,
    lastSyncCursor: row.lastSyncCursor,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    name: row.name,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorTarget(row: ConnectorTargetRow) {
  return {
    connectorInstanceId: row.connectorInstanceId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    externalTargetRef: row.externalTargetRef,
    id: row.id,
    remoteId: row.remoteId,
    targetConfigJson: row.targetConfigJson,
    targetKind: row.targetKind,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorMapping(row: ConnectorMappingRow) {
  return {
    autoAddToPlugin: row.autoAddToPlugin,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    mappingConfigJson: row.mappingConfigJson,
    mappingKind: row.mappingKind,
    objectType: row.objectType,
    pluginId: row.pluginId,
    remoteId: row.remoteId,
    selector: row.selector,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeConnectorSyncEvent(row: ConnectorSyncEventRow) {
  return {
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    eventType: row.eventType,
    externalEventRef: row.externalEventRef,
    id: row.id,
    remoteId: row.remoteId,
    sourceRevisionRef: row.sourceRevisionRef,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    summaryJson: row.summaryJson,
  }
}

async function getConfigObjectRow(organizationId: OrganizationId, configObjectId: ConfigObjectId) {
  const rows = await db
    .select()
    .from(ConfigObjectTable)
    .where(and(eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.id, configObjectId)))
    .limit(1)

  return rows[0] ?? null
}

async function getPluginRow(organizationId: OrganizationId, pluginId: PluginId) {
  const rows = await db
    .select()
    .from(PluginTable)
    .where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.id, pluginId)))
    .limit(1)

  return rows[0] ?? null
}

async function getMarketplaceRow(organizationId: OrganizationId, marketplaceId: MarketplaceId) {
  const rows = await db
    .select()
    .from(MarketplaceTable)
    .where(and(eq(MarketplaceTable.organizationId, organizationId), eq(MarketplaceTable.id, marketplaceId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorAccountRow(organizationId: OrganizationId, connectorAccountId: ConnectorAccountId) {
  const rows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.organizationId, organizationId), eq(ConnectorAccountTable.id, connectorAccountId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorInstanceRow(organizationId: OrganizationId, connectorInstanceId: ConnectorInstanceId) {
  const rows = await db
    .select()
    .from(ConnectorInstanceTable)
    .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, connectorInstanceId)))
    .limit(1)

  return rows[0] ?? null
}

async function getConnectorTargetRow(organizationId: OrganizationId, connectorTargetId: ConnectorTargetId) {
  const rows = await db
    .select({ target: ConnectorTargetTable, instance: ConnectorInstanceTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorTargetTable.id, connectorTargetId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.target ?? null
}

async function getConnectorMappingRow(organizationId: OrganizationId, connectorMappingId: ConnectorMappingId) {
  const rows = await db
    .select({ mapping: ConnectorMappingTable, instance: ConnectorInstanceTable })
    .from(ConnectorMappingTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorMappingTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorMappingTable.id, connectorMappingId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.mapping ?? null
}

async function getConnectorSyncEventRow(organizationId: OrganizationId, connectorSyncEventId: ConnectorSyncEventId) {
  const rows = await db
    .select({ event: ConnectorSyncEventTable, instance: ConnectorInstanceTable })
    .from(ConnectorSyncEventTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorSyncEventTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorSyncEventTable.id, connectorSyncEventId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.event ?? null
}

async function ensureVisibleConfigObject(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const row = await getConfigObjectRow(context.organizationContext.organization.id, configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "config_object", role: "viewer" })
  return row
}

async function ensureEditablePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "plugin", role: "editor" })
  return row
}

async function ensureEditableMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "editor" })
  return row
}

async function ensureVisibleMarketplace(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await getMarketplaceRow(context.organizationContext.organization.id, marketplaceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "marketplace_not_found", "Marketplace not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "marketplace", role: "viewer" })
  return row
}

async function ensureVisiblePlugin(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await getPluginRow(context.organizationContext.organization.id, pluginId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "plugin_not_found", "Plugin not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "plugin", role: "viewer" })
  return row
}

async function ensureVisibleConnectorInstance(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await getConnectorInstanceRow(context.organizationContext.organization.id, connectorInstanceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "connector_instance", role: "viewer" })
  return row
}

async function ensureEditableConnectorInstance(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await getConnectorInstanceRow(context.organizationContext.organization.id, connectorInstanceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "connector_instance", role: "editor" })
  return row
}

async function upsertGrant(input: ResourceTarget & {
  context: PluginArchActorContext
  value: AccessGrantWrite
}) {
  const createdAt = new Date()
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const organizationId = input.context.organizationContext.organization.id

  if (input.resourceKind === "config_object") {
    const existing = await db
      .select()
      .from(ConfigObjectAccessGrantTable)
      .where(and(
        eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId),
        input.value.orgMembershipId
          ? eq(ConfigObjectAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(ConfigObjectAccessGrantTable.teamId, input.value.teamId)
            : eq(ConfigObjectAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(ConfigObjectAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(ConfigObjectAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      configObjectId: input.resourceId,
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("configObjectAccessGrant"),
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(ConfigObjectAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  if (input.resourceKind === "marketplace") {
    const existing = await db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(
        eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId),
        input.value.orgMembershipId
          ? eq(MarketplaceAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(MarketplaceAccessGrantTable.teamId, input.value.teamId)
            : eq(MarketplaceAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(MarketplaceAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(MarketplaceAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("marketplaceAccessGrant"),
      marketplaceId: input.resourceId,
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(MarketplaceAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  if (input.resourceKind === "plugin") {
    const existing = await db
      .select()
      .from(PluginAccessGrantTable)
      .where(and(
        eq(PluginAccessGrantTable.pluginId, input.resourceId),
        input.value.orgMembershipId
          ? eq(PluginAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
          : input.value.teamId
            ? eq(PluginAccessGrantTable.teamId, input.value.teamId)
            : eq(PluginAccessGrantTable.orgWide, true),
      ))
      .limit(1)

    if (existing[0]) {
      await db
        .update(PluginAccessGrantTable)
        .set({
          createdByOrgMembershipId,
          orgMembershipId: input.value.orgMembershipId ?? null,
          orgWide: input.value.orgWide ?? false,
          removedAt: null,
          role: input.value.role,
          teamId: input.value.teamId ?? null,
        })
        .where(eq(PluginAccessGrantTable.id, existing[0].id))
      return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
    }

    const row = {
      createdAt,
      createdByOrgMembershipId,
      id: createDenTypeId("pluginAccessGrant"),
      organizationId,
      orgMembershipId: input.value.orgMembershipId ?? null,
      orgWide: input.value.orgWide ?? false,
      pluginId: input.resourceId,
      role: input.value.role,
      teamId: input.value.teamId ?? null,
    }
    await db.insert(PluginAccessGrantTable).values(row)
    return serializeAccessGrant({ ...row, removedAt: null })
  }

  const existing = await db
    .select()
    .from(ConnectorInstanceAccessGrantTable)
    .where(and(
      eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId),
      input.value.orgMembershipId
        ? eq(ConnectorInstanceAccessGrantTable.orgMembershipId, input.value.orgMembershipId)
        : input.value.teamId
          ? eq(ConnectorInstanceAccessGrantTable.teamId, input.value.teamId)
          : eq(ConnectorInstanceAccessGrantTable.orgWide, true),
    ))
    .limit(1)

  if (existing[0]) {
    await db
      .update(ConnectorInstanceAccessGrantTable)
      .set({
        createdByOrgMembershipId,
        orgMembershipId: input.value.orgMembershipId ?? null,
        orgWide: input.value.orgWide ?? false,
        removedAt: null,
        role: input.value.role,
        teamId: input.value.teamId ?? null,
      })
      .where(eq(ConnectorInstanceAccessGrantTable.id, existing[0].id))
    return serializeAccessGrant({ ...existing[0], createdByOrgMembershipId, orgMembershipId: input.value.orgMembershipId ?? null, orgWide: input.value.orgWide ?? false, removedAt: null, role: input.value.role, teamId: input.value.teamId ?? null })
  }

  const row = {
    connectorInstanceId: input.resourceId,
    createdAt,
    createdByOrgMembershipId,
    id: createDenTypeId("connectorInstanceAccessGrant"),
    organizationId,
    orgMembershipId: input.value.orgMembershipId ?? null,
    orgWide: input.value.orgWide ?? false,
    role: input.value.role,
    teamId: input.value.teamId ?? null,
  }
  await db.insert(ConnectorInstanceAccessGrantTable).values(row)
  return serializeAccessGrant({ ...row, removedAt: null })
}

async function removeGrant(input: GrantTarget & { context: PluginArchActorContext }) {
  const removedAt = new Date()
  if (input.resourceKind === "config_object") {
    const rows = await db
      .select()
      .from(ConfigObjectAccessGrantTable)
      .where(and(eq(ConfigObjectAccessGrantTable.id, input.grantId), eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(ConfigObjectAccessGrantTable).set({ removedAt }).where(eq(ConfigObjectAccessGrantTable.id, input.grantId))
    return
  }
  if (input.resourceKind === "marketplace") {
    const rows = await db
      .select()
      .from(MarketplaceAccessGrantTable)
      .where(and(eq(MarketplaceAccessGrantTable.id, input.grantId), eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(MarketplaceAccessGrantTable).set({ removedAt }).where(eq(MarketplaceAccessGrantTable.id, input.grantId))
    return
  }
  if (input.resourceKind === "plugin") {
    const rows = await db
      .select()
      .from(PluginAccessGrantTable)
      .where(and(eq(PluginAccessGrantTable.id, input.grantId), eq(PluginAccessGrantTable.pluginId, input.resourceId)))
      .limit(1)
    if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
    await db.update(PluginAccessGrantTable).set({ removedAt }).where(eq(PluginAccessGrantTable.id, input.grantId))
    return
  }
  const rows = await db
    .select()
    .from(ConnectorInstanceAccessGrantTable)
    .where(and(eq(ConnectorInstanceAccessGrantTable.id, input.grantId), eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId)))
    .limit(1)
  if (!rows[0]) throw new PluginArchRouteFailure(404, "access_grant_not_found", "Access grant not found.")
  await db.update(ConnectorInstanceAccessGrantTable).set({ removedAt }).where(eq(ConnectorInstanceAccessGrantTable.id, input.grantId))
}

export async function listConfigObjects(input: {
  connectorInstanceId?: ConnectorInstanceId
  context: PluginArchActorContext
  cursor?: string
  includeDeleted?: boolean
  limit?: number
  pluginId?: PluginId
  q?: string
  sourceMode?: ConfigObjectRow["sourceMode"]
  status?: ConfigObjectRow["status"]
  type?: ConfigObjectRow["objectType"]
}) {
  const organizationId = input.context.organizationContext.organization.id
  const rows = await db
    .select()
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.organizationId, organizationId))
    .orderBy(desc(ConfigObjectTable.updatedAt), desc(ConfigObjectTable.id))

  const latestVersions = await getLatestVersions(rows.map((row) => row.id))
  const filtered: ReturnType<typeof serializeConfigObject>[] = []

  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object" })
    if (!role) continue
    if (input.type && row.objectType !== input.type) continue
    if (input.status && row.status !== input.status) continue
    if (input.sourceMode && row.sourceMode !== input.sourceMode) continue
    if (!input.includeDeleted && row.status === "deleted") continue
    if (input.connectorInstanceId && row.connectorInstanceId !== input.connectorInstanceId) continue
    if (input.q) {
      const haystack = `${row.title}\n${row.description ?? ""}\n${row.searchText ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    if (input.pluginId) {
      const memberships = await db
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, row.id), isNull(PluginConfigObjectTable.removedAt)))
        .limit(1)
      if (!memberships[0]) continue
    }
    filtered.push(serializeConfigObject(row, latestVersions.get(row.id) ?? null))
  }

  return pageItems(filtered, input.cursor, input.limit)
}

export async function getConfigObjectDetail(context: PluginArchActorContext, configObjectId: ConfigObjectId) {
  const row = await ensureVisibleConfigObject(context, configObjectId)
  const latest = await getLatestVersions([row.id])
  return serializeConfigObject(row, latest.get(row.id) ?? null)
}

export async function createConfigObject(input: {
  context: PluginArchActorContext
  objectType: ConfigObjectRow["objectType"]
  pluginIds?: PluginId[]
  sourceMode: ConfigObjectRow["sourceMode"]
  value: ConfigObjectInput
}) {
  if (input.sourceMode === "connector") {
    throw new PluginArchRouteFailure(400, "invalid_request", "Connector-managed config objects must be created through connector sync.")
  }

  for (const pluginId of input.pluginIds ?? []) {
    await requirePluginArchResourceRole({ context: input.context, resourceId: pluginId, resourceKind: "plugin", role: "editor" })
  }

  const now = new Date()
  const projection = deriveProjection({ objectType: input.objectType, value: input.value })
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const configObjectId = createDenTypeId("configObject")
  const versionId = createDenTypeId("configObjectVersion")

  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectTable).values({
      createdAt: now,
      createdByOrgMembershipId,
      currentFileExtension: null,
      currentFileName: null,
      currentRelativePath: null,
      deletedAt: null,
      description: projection.description,
      id: configObjectId,
      objectType: input.objectType,
      organizationId,
      searchText: projection.searchText,
      sourceMode: input.sourceMode,
      status: "active",
      title: projection.title,
      updatedAt: now,
      connectorInstanceId: null,
    })

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId,
        connectorSyncEventId: null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: input.sourceMode,
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: input.value.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.value.rawSourceText),
      schemaVersion: normalizeOptionalString(input.value.schemaVersion),
      sourceRevisionRef: null,
    })

      await tx.insert(ConfigObjectAccessGrantTable).values({
        configObjectId,
        createdAt: now,
        createdByOrgMembershipId,
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        orgMembershipId: createdByOrgMembershipId,
      orgWide: false,
      role: "manager",
      teamId: null,
    })

    for (const pluginId of input.pluginIds ?? []) {
      const existing = await tx
        .select({ id: PluginConfigObjectTable.id })
        .from(PluginConfigObjectTable)
        .where(and(eq(PluginConfigObjectTable.pluginId, pluginId), eq(PluginConfigObjectTable.configObjectId, configObjectId)))
        .limit(1)

      if (existing[0]) {
        await tx.update(PluginConfigObjectTable).set({ removedAt: null }).where(eq(PluginConfigObjectTable.id, existing[0].id))
      } else {
        await tx.insert(PluginConfigObjectTable).values({
          configObjectId,
          connectorMappingId: null,
          createdAt: now,
          createdByOrgMembershipId,
          id: createDenTypeId("pluginConfigObject"),
          membershipSource: "manual",
          organizationId,
          pluginId,
        })
      }
    }
  })

  return getConfigObjectDetail(input.context, configObjectId)
}

export async function listConfigObjectVersions(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; cursor?: string; includeDeleted?: boolean; limit?: number }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, configObject.id))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))

  const items = rows
    .filter((row) => input.includeDeleted || !row.isDeletedVersion)
    .map((row) => ({ ...serializeVersion(row), id: row.id }))

  return pageItems(items, input.cursor, input.limit)
}

export async function getConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; versionId: ConfigObjectVersionId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(and(eq(ConfigObjectVersionTable.id, input.versionId), eq(ConfigObjectVersionTable.configObjectId, input.configObjectId)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "config_object_version_not_found", "Config object version not found.")
  }
  return serializeVersion(rows[0])
}

export async function getLatestConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(eq(ConfigObjectVersionTable.configObjectId, input.configObjectId))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "config_object_version_not_found", "Config object version not found.")
  }
  return serializeVersion(rows[0])
}

export async function createConfigObjectVersion(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; reason?: string; value: ConfigObjectInput }) {
  const row = await getConfigObjectRow(input.context.organizationContext.organization.id, input.configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object", role: "editor" })

  const now = new Date()
  const projection = deriveProjection({ objectType: row.objectType, value: input.value })
  await db.transaction(async (tx) => {
    await tx.insert(ConfigObjectVersionTable).values({
      configObjectId: row.id,
      connectorSyncEventId: null,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      createdVia: row.sourceMode === "connector" ? "connector" : row.sourceMode,
      id: createDenTypeId("configObjectVersion"),
      isDeletedVersion: false,
      normalizedPayloadJson: input.value.normalizedPayloadJson ?? null,
      organizationId: row.organizationId,
      rawSourceText: normalizeOptionalString(input.value.rawSourceText),
      schemaVersion: normalizeOptionalString(input.value.schemaVersion),
      sourceRevisionRef: normalizeOptionalString(input.reason),
    })

    await tx.update(ConfigObjectTable).set({
      description: projection.description,
      searchText: projection.searchText,
      title: projection.title,
      updatedAt: now,
    }).where(eq(ConfigObjectTable.id, row.id))
  })

  return getConfigObjectDetail(input.context, row.id)
}

export async function setConfigObjectLifecycle(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; action: "archive" | "delete" | "restore" }) {
  const row = await getConfigObjectRow(input.context.organizationContext.organization.id, input.configObjectId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "config_object_not_found", "Config object not found.")
  }
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "config_object", role: "manager" })
  const now = new Date()
  const patch = input.action === "archive"
    ? { deletedAt: null, status: "archived" as const, updatedAt: now }
    : input.action === "delete"
      ? { deletedAt: now, status: "deleted" as const, updatedAt: now }
      : { deletedAt: null, status: "active" as const, updatedAt: now }

  await db.update(ConfigObjectTable).set(patch).where(eq(ConfigObjectTable.id, row.id))
  return getConfigObjectDetail(input.context, row.id)
}

export async function listConfigObjectPlugins(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId }) {
  const configObject = await ensureVisibleConfigObject(input.context, input.configObjectId)
  const latest = await getLatestVersions([configObject.id])
  const memberships = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(eq(PluginConfigObjectTable.configObjectId, configObject.id))
    .orderBy(desc(PluginConfigObjectTable.createdAt))

  const serializedConfigObject = serializeConfigObject(configObject, latest.get(configObject.id) ?? null)
  const visible: ReturnType<typeof serializeMembership>[] = []
  for (const membership of memberships) {
    const pluginRole = await resolvePluginArchResourceRole({ context: input.context, resourceId: membership.pluginId, resourceKind: "plugin" })
    if (!pluginRole) continue
    visible.push(serializeMembership(membership, serializedConfigObject))
  }
  return { items: visible, nextCursor: null }
}

export async function attachConfigObjectToPlugin(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; membershipSource?: PluginMembershipRow["membershipSource"]; pluginId: PluginId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  await ensureEditablePlugin(input.context, input.pluginId)

  const existing = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId)))
    .limit(1)

  const now = new Date()
  let membershipId = existing[0]?.id ?? null
  if (existing[0]) {
    await db.update(PluginConfigObjectTable).set({ membershipSource: input.membershipSource ?? existing[0].membershipSource, removedAt: null }).where(eq(PluginConfigObjectTable.id, existing[0].id))
  } else {
    membershipId = createDenTypeId("pluginConfigObject")
    await db.insert(PluginConfigObjectTable).values({
      configObjectId: input.configObjectId,
      connectorMappingId: null,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: membershipId,
      membershipSource: input.membershipSource ?? "manual",
      organizationId: input.context.organizationContext.organization.id,
      pluginId: input.pluginId,
    })
  }

  const rows = await db.select().from(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.id, membershipId!)).limit(1)
  return serializeMembership(rows[0])
}

export async function removeConfigObjectFromPlugin(input: { context: PluginArchActorContext; configObjectId: ConfigObjectId; pluginId: PluginId }) {
  await ensureVisibleConfigObject(input.context, input.configObjectId)
  await ensureEditablePlugin(input.context, input.pluginId)
  const rows = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(and(eq(PluginConfigObjectTable.pluginId, input.pluginId), eq(PluginConfigObjectTable.configObjectId, input.configObjectId), isNull(PluginConfigObjectTable.removedAt)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "plugin_membership_not_found", "Plugin membership not found.")
  }
  await db.update(PluginConfigObjectTable).set({ removedAt: new Date() }).where(eq(PluginConfigObjectTable.id, rows[0].id))
}

export async function listResourceAccess(input: { context: PluginArchActorContext } & ResourceTarget) {
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })

  if (input.resourceKind === "config_object") {
    const rows = await db.select().from(ConfigObjectAccessGrantTable).where(eq(ConfigObjectAccessGrantTable.configObjectId, input.resourceId)).orderBy(desc(ConfigObjectAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  if (input.resourceKind === "marketplace") {
    const rows = await db.select().from(MarketplaceAccessGrantTable).where(eq(MarketplaceAccessGrantTable.marketplaceId, input.resourceId)).orderBy(desc(MarketplaceAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  if (input.resourceKind === "plugin") {
    const rows = await db.select().from(PluginAccessGrantTable).where(eq(PluginAccessGrantTable.pluginId, input.resourceId)).orderBy(desc(PluginAccessGrantTable.createdAt))
    return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
  }
  const rows = await db.select().from(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, input.resourceId)).orderBy(desc(ConnectorInstanceAccessGrantTable.createdAt))
  return { items: rows.map((row) => serializeAccessGrant(row)), nextCursor: null }
}

export async function createResourceAccessGrant(input: { context: PluginArchActorContext; value: AccessGrantWrite } & ResourceTarget) {
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })
  return upsertGrant(input)
}

export async function deleteResourceAccessGrant(input: { context: PluginArchActorContext } & GrantTarget) {
  await requirePluginArchResourceRole({ context: input.context, resourceId: input.resourceId, resourceKind: input.resourceKind, role: "manager" })
  return removeGrant(input)
}

async function collectPluginMarketplaces(organizationId: PluginRow["organizationId"], pluginIds: PluginId[]): Promise<Map<string, PluginMarketplaceSummary[]>> {
  const byPlugin = new Map<string, PluginMarketplaceSummary[]>()
  if (pluginIds.length === 0) {
    return byPlugin
  }

  const rows = await db
    .select({
      marketplaceId: MarketplaceTable.id,
      marketplaceName: MarketplaceTable.name,
      pluginId: MarketplacePluginTable.pluginId,
    })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      eq(MarketplaceTable.organizationId, organizationId),
      isNull(MarketplacePluginTable.removedAt),
      isNull(MarketplaceTable.deletedAt),
      inArray(MarketplacePluginTable.pluginId, pluginIds),
    ))

  for (const row of rows) {
    const existing = byPlugin.get(row.pluginId) ?? []
    existing.push({ id: row.marketplaceId, name: row.marketplaceName })
    byPlugin.set(row.pluginId, existing)
  }
  return byPlugin
}

export async function listPlugins(input: { context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; status?: PluginRow["status"] }) {
  const rows = await db
    .select()
    .from(PluginTable)
    .where(eq(PluginTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(PluginTable.updatedAt), desc(PluginTable.id))

  const memberships = await db
    .select({ pluginId: PluginConfigObjectTable.pluginId, count: PluginConfigObjectTable.id })
    .from(PluginConfigObjectTable)
    .where(isNull(PluginConfigObjectTable.removedAt))

  const counts = memberships.reduce((accumulator, row) => {
    accumulator.set(row.pluginId, (accumulator.get(row.pluginId) ?? 0) + 1)
    return accumulator
  }, new Map<string, number>())

  const marketplaceMembers = await collectPluginMarketplaces(
    input.context.organizationContext.organization.id,
    rows.map((row) => row.id),
  )

  const visible: ReturnType<typeof serializePlugin>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "plugin" })
    if (!role) continue
    if (input.status && row.status !== input.status) continue
    if (input.q) {
      const haystack = `${row.name}\n${row.description ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    visible.push(serializePlugin(row, counts.get(row.id) ?? 0, marketplaceMembers.get(row.id) ?? []))
  }

  return pageItems(visible, input.cursor, input.limit)
}

export async function getPluginDetail(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await ensureVisiblePlugin(context, pluginId)
  const memberships = await db.select({ id: PluginConfigObjectTable.id }).from(PluginConfigObjectTable).where(and(eq(PluginConfigObjectTable.pluginId, row.id), isNull(PluginConfigObjectTable.removedAt)))
  const marketplaceMembers = await collectPluginMarketplaces(context.organizationContext.organization.id, [row.id])
  return serializePlugin(row, memberships.length, marketplaceMembers.get(row.id) ?? [])
}

export async function createPlugin(input: { context: PluginArchActorContext; description?: string | null; name: string }) {
  const now = new Date()
  const row = {
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: normalizeOptionalString(input.description ?? undefined),
    id: createDenTypeId("plugin"),
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
    status: "active" as const,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    await tx.insert(PluginTable).values(row)
    await tx.insert(PluginAccessGrantTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("pluginAccessGrant"),
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      pluginId: row.id,
      role: "manager",
      teamId: null,
    })
  })

  return serializePlugin(row, 0)
}

export async function updatePlugin(input: { context: PluginArchActorContext; description?: string | null; name?: string; pluginId: PluginId }) {
  const row = await ensureEditablePlugin(input.context, input.pluginId)
  const updatedAt = new Date()
  await db.update(PluginTable).set({
    description: input.description === undefined ? row.description : normalizeOptionalString(input.description ?? undefined),
    name: input.name?.trim() || row.name,
    updatedAt,
  }).where(eq(PluginTable.id, row.id))
  return getPluginDetail(input.context, row.id)
}

export async function setPluginLifecycle(input: { action: "archive" | "restore"; context: PluginArchActorContext; pluginId: PluginId }) {
  const row = await ensureVisiblePlugin(input.context, input.pluginId)
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "plugin", role: "manager" })
  const updatedAt = new Date()
  await db.update(PluginTable).set({
    deletedAt: input.action === "archive" ? row.deletedAt : null,
    status: input.action === "archive" ? "archived" : "active",
    updatedAt,
  }).where(eq(PluginTable.id, row.id))
  return getPluginDetail(input.context, row.id)
}

export async function listPluginMemberships(input: { context: PluginArchActorContext; pluginId: PluginId; includeConfigObjects?: boolean; onlyActive?: boolean }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  const memberships = await db
    .select()
    .from(PluginConfigObjectTable)
    .where(input.onlyActive ? and(eq(PluginConfigObjectTable.pluginId, input.pluginId), isNull(PluginConfigObjectTable.removedAt)) : eq(PluginConfigObjectTable.pluginId, input.pluginId))
    .orderBy(desc(PluginConfigObjectTable.createdAt))

  if (!input.includeConfigObjects) {
    return { items: memberships.map((membership) => serializeMembership(membership)), nextCursor: null }
  }

  const configObjects = await db.select().from(ConfigObjectTable).where(inArray(ConfigObjectTable.id, memberships.map((membership) => membership.configObjectId)))
  const latestVersions = await getLatestVersions(configObjects.map((row) => row.id))
  const byId = new Map<string, ReturnType<typeof serializeConfigObject>>(configObjects.map((row) => [row.id, serializeConfigObject(row, latestVersions.get(row.id) ?? null)]))
  return { items: memberships.map((membership) => serializeMembership(membership, byId.get(membership.configObjectId))), nextCursor: null }
}

export async function addPluginMembership(input: { configObjectId: ConfigObjectId; context: PluginArchActorContext; membershipSource?: PluginMembershipRow["membershipSource"]; pluginId: PluginId }) {
  return attachConfigObjectToPlugin({ ...input })
}

export async function removePluginMembership(input: { configObjectId: ConfigObjectId; context: PluginArchActorContext; pluginId: PluginId }) {
  return removeConfigObjectFromPlugin(input)
}

export async function listMarketplaces(input: { context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; status?: MarketplaceRow["status"] }) {
  const rows = await db
    .select()
    .from(MarketplaceTable)
    .where(eq(MarketplaceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(MarketplaceTable.updatedAt), desc(MarketplaceTable.id))

  const memberships = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId, count: MarketplacePluginTable.id })
    .from(MarketplacePluginTable)
    .where(isNull(MarketplacePluginTable.removedAt))

  const counts = memberships.reduce((accumulator, row) => {
    accumulator.set(row.marketplaceId, (accumulator.get(row.marketplaceId) ?? 0) + 1)
    return accumulator
  }, new Map<string, number>())

  const visible: ReturnType<typeof serializeMarketplace>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "marketplace" })
    if (!role) continue
    if (input.status && row.status !== input.status) continue
    if (input.q) {
      const haystack = `${row.name}\n${row.description ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    visible.push(serializeMarketplace(row, counts.get(row.id) ?? 0))
  }

  return pageItems(visible, input.cursor, input.limit)
}

export async function getMarketplaceDetail(context: PluginArchActorContext, marketplaceId: MarketplaceId) {
  const row = await ensureVisibleMarketplace(context, marketplaceId)
  const memberships = await db
    .select({ id: MarketplacePluginTable.id })
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, row.id), isNull(MarketplacePluginTable.removedAt)))
  return serializeMarketplace(row, memberships.length)
}

export async function createMarketplace(input: { context: PluginArchActorContext; description?: string | null; name: string }) {
  const now = new Date()
  const row = {
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    deletedAt: null,
    description: normalizeOptionalString(input.description ?? undefined),
    id: createDenTypeId("marketplace"),
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
    status: "active" as const,
    updatedAt: now,
  }

  await db.transaction(async (tx) => {
    await tx.insert(MarketplaceTable).values(row)
    await tx.insert(MarketplaceAccessGrantTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("marketplaceAccessGrant"),
      marketplaceId: row.id,
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      role: "manager",
      teamId: null,
    })
  })

  return serializeMarketplace(row, 0)
}

export async function updateMarketplace(input: { context: PluginArchActorContext; description?: string | null; marketplaceId: MarketplaceId; name?: string }) {
  const row = await ensureEditableMarketplace(input.context, input.marketplaceId)
  const updatedAt = new Date()
  await db.update(MarketplaceTable).set({
    description: input.description === undefined ? row.description : normalizeOptionalString(input.description ?? undefined),
    name: input.name?.trim() || row.name,
    updatedAt,
  }).where(eq(MarketplaceTable.id, row.id))
  return getMarketplaceDetail(input.context, row.id)
}

export async function setMarketplaceLifecycle(input: { action: "archive" | "restore"; context: PluginArchActorContext; marketplaceId: MarketplaceId }) {
  const row = await ensureVisibleMarketplace(input.context, input.marketplaceId)
  await requirePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "marketplace", role: "manager" })
  const updatedAt = new Date()
  await db.update(MarketplaceTable).set({
    deletedAt: input.action === "archive" ? row.deletedAt : null,
    status: input.action === "archive" ? "archived" : "active",
    updatedAt,
  }).where(eq(MarketplaceTable.id, row.id))
  return getMarketplaceDetail(input.context, row.id)
}

export async function listMarketplaceMemberships(input: { context: PluginArchActorContext; includePlugins?: boolean; marketplaceId: MarketplaceId; onlyActive?: boolean }) {
  await ensureVisibleMarketplace(input.context, input.marketplaceId)
  const memberships = await db
    .select()
    .from(MarketplacePluginTable)
    .where(input.onlyActive ? and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), isNull(MarketplacePluginTable.removedAt)) : eq(MarketplacePluginTable.marketplaceId, input.marketplaceId))
    .orderBy(desc(MarketplacePluginTable.createdAt))

  if (!input.includePlugins) {
    return { items: memberships.map((membership) => serializeMarketplaceMembership(membership)), nextCursor: null }
  }

  const plugins = memberships.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, memberships.map((membership) => membership.pluginId)))
  const byId = new Map<string, ReturnType<typeof serializePlugin>>(plugins.map((row) => [row.id, serializePlugin(row)]))
  return { items: memberships.map((membership) => serializeMarketplaceMembership(membership, byId.get(membership.pluginId))), nextCursor: null }
}

export type MarketplaceResolvedSource = {
  connectorAccountId: string
  connectorInstanceId: string
  accountLogin: string | null
  repositoryFullName: string
  branch: string | null
} | null

export async function getMarketplaceResolved(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId }) {
  const marketplaceRow = await ensureVisibleMarketplace(input.context, input.marketplaceId)
  const organizationId = input.context.organizationContext.organization.id

  const memberships = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, marketplaceRow.id), isNull(MarketplacePluginTable.removedAt)))
    .orderBy(desc(MarketplacePluginTable.createdAt))

  const pluginIds = memberships.map((membership) => membership.pluginId)
  const pluginRows = pluginIds.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, pluginIds))

  const activePluginMemberships = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId, configObjectId: PluginConfigObjectTable.configObjectId })
      .from(PluginConfigObjectTable)
      .where(and(inArray(PluginConfigObjectTable.pluginId, pluginIds), isNull(PluginConfigObjectTable.removedAt)))
  const memberCounts = new Map<string, number>()
  for (const entry of activePluginMemberships) {
    memberCounts.set(entry.pluginId, (memberCounts.get(entry.pluginId) ?? 0) + 1)
  }

  const configObjectIds = [...new Set(activePluginMemberships.map((entry) => entry.configObjectId))]
  const configObjectTypeById = new Map<string, string>()
  if (configObjectIds.length > 0) {
    const rows = await db
      .select({ id: ConfigObjectTable.id, objectType: ConfigObjectTable.objectType })
      .from(ConfigObjectTable)
      .where(inArray(ConfigObjectTable.id, configObjectIds))
    for (const row of rows) {
      configObjectTypeById.set(row.id, row.objectType)
    }
  }

  const componentCountsByPlugin = new Map<string, Map<string, number>>()
  for (const entry of activePluginMemberships) {
    const objectType = configObjectTypeById.get(entry.configObjectId)
    if (!objectType) continue
    let counts = componentCountsByPlugin.get(entry.pluginId)
    if (!counts) {
      counts = new Map<string, number>()
      componentCountsByPlugin.set(entry.pluginId, counts)
    }
    counts.set(objectType, (counts.get(objectType) ?? 0) + 1)
  }

  const plugins = pluginRows.map((row) => ({
    ...serializePlugin(row, memberCounts.get(row.id) ?? 0),
    componentCounts: Object.fromEntries(componentCountsByPlugin.get(row.id) ?? new Map()),
  }))

  let source: MarketplaceResolvedSource = null
  if (pluginIds.length > 0) {
    const mappingRows = await db
      .selectDistinct({ connectorInstanceId: ConnectorMappingTable.connectorInstanceId })
      .from(ConnectorMappingTable)
      .where(and(
        eq(ConnectorMappingTable.organizationId, organizationId),
        inArray(ConnectorMappingTable.pluginId, pluginIds),
      ))
    const connectorInstanceIds = mappingRows.map((entry) => entry.connectorInstanceId)
    if (connectorInstanceIds.length === 1) {
      const [instance] = await db
        .select()
        .from(ConnectorInstanceTable)
        .where(eq(ConnectorInstanceTable.id, connectorInstanceIds[0]))
        .limit(1)
      if (instance) {
        const [account] = await db
          .select()
          .from(ConnectorAccountTable)
          .where(eq(ConnectorAccountTable.id, instance.connectorAccountId))
          .limit(1)
        const [target] = await db
          .select()
          .from(ConnectorTargetTable)
          .where(eq(ConnectorTargetTable.connectorInstanceId, instance.id))
          .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))
          .limit(1)
        const targetConfig = target?.targetConfigJson && typeof target.targetConfigJson === "object"
          ? target.targetConfigJson as Record<string, unknown>
          : {}
        const repositoryFullName = typeof targetConfig.repositoryFullName === "string"
          ? targetConfig.repositoryFullName
          : instance.remoteId ?? ""
        source = {
          connectorAccountId: instance.connectorAccountId,
          connectorInstanceId: instance.id,
          accountLogin: account?.externalAccountRef ?? (account?.metadataJson && typeof account.metadataJson === "object" ? (account.metadataJson as Record<string, unknown>).accountLogin as string ?? null : null),
          repositoryFullName,
          branch: typeof targetConfig.branch === "string" ? targetConfig.branch : target?.externalTargetRef ?? null,
        }
      }
    }
  }

  return {
    marketplace: serializeMarketplace(marketplaceRow, plugins.length),
    plugins,
    source,
  }
}

export async function attachPluginToMarketplace(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId; membershipSource?: MarketplaceMembershipRow["membershipSource"]; pluginId: PluginId }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  await ensureEditableMarketplace(input.context, input.marketplaceId)

  const existing = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId)))
    .limit(1)

  const now = new Date()
  let membershipId: MarketplaceMembershipId | null = existing[0]?.id ?? null
  if (existing[0]) {
    await db.update(MarketplacePluginTable).set({ membershipSource: input.membershipSource ?? existing[0].membershipSource, removedAt: null }).where(eq(MarketplacePluginTable.id, existing[0].id))
  } else {
    membershipId = createDenTypeId("marketplacePlugin")
    await db.insert(MarketplacePluginTable).values({
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: membershipId,
      marketplaceId: input.marketplaceId,
      membershipSource: input.membershipSource ?? "manual",
      organizationId: input.context.organizationContext.organization.id,
      pluginId: input.pluginId,
    })
  }

  const rows = await db.select().from(MarketplacePluginTable).where(eq(MarketplacePluginTable.id, membershipId!)).limit(1)
  return serializeMarketplaceMembership(rows[0])
}

export async function removePluginFromMarketplace(input: { context: PluginArchActorContext; marketplaceId: MarketplaceId; pluginId: PluginId }) {
  await ensureVisiblePlugin(input.context, input.pluginId)
  await ensureEditableMarketplace(input.context, input.marketplaceId)
  const rows = await db
    .select()
    .from(MarketplacePluginTable)
    .where(and(eq(MarketplacePluginTable.marketplaceId, input.marketplaceId), eq(MarketplacePluginTable.pluginId, input.pluginId), isNull(MarketplacePluginTable.removedAt)))
    .limit(1)
  if (!rows[0]) {
    throw new PluginArchRouteFailure(404, "marketplace_membership_not_found", "Marketplace membership not found.")
  }
  await db.update(MarketplacePluginTable).set({ removedAt: new Date() }).where(eq(MarketplacePluginTable.id, rows[0].id))
}

export async function listConnectorAccounts(input: { context: PluginArchActorContext; connectorType?: ConnectorAccountRow["connectorType"]; cursor?: string; limit?: number; q?: string; status?: ConnectorAccountRow["status"] }) {
  const rows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(eq(ConnectorAccountTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorAccountTable.updatedAt), desc(ConnectorAccountTable.id))

  const filtered = rows
    .filter((row) => !input.connectorType || row.connectorType === input.connectorType)
    .filter((row) => !input.status || row.status === input.status)
    .filter((row) => !input.q || `${row.displayName}\n${row.remoteId}\n${row.externalAccountRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorAccount(row, resolveCreatorName(input.context, row.createdByOrgMembershipId)))

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorAccount(input: { context: PluginArchActorContext; connectorType: ConnectorAccountRow["connectorType"]; displayName: string; externalAccountRef?: string | null; metadata?: Record<string, unknown>; remoteId: string }) {
  const now = new Date()
  const row = {
    connectorType: input.connectorType,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    displayName: input.displayName.trim(),
    externalAccountRef: normalizeOptionalString(input.externalAccountRef ?? undefined),
    id: createDenTypeId("connectorAccount"),
    metadataJson: input.metadata ?? null,
    organizationId: input.context.organizationContext.organization.id,
    remoteId: input.remoteId.trim(),
    status: "active" as const,
    updatedAt: now,
  }
  await db.insert(ConnectorAccountTable).values(row)
  return serializeConnectorAccount(row)
}

export async function getConnectorAccountDetail(context: PluginArchActorContext, connectorAccountId: ConnectorAccountId) {
  const row = await getConnectorAccountRow(context.organizationContext.organization.id, connectorAccountId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  return serializeConnectorAccount(row, resolveCreatorName(context, row.createdByOrgMembershipId))
}

export async function disconnectConnectorAccount(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; reason?: string }) {
  const organizationId = input.context.organizationContext.organization.id
  const row = await getConnectorAccountRow(organizationId, input.connectorAccountId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }

  const instances = await db
    .select({ id: ConnectorInstanceTable.id })
    .from(ConnectorInstanceTable)
    .where(and(
      eq(ConnectorInstanceTable.organizationId, organizationId),
      eq(ConnectorInstanceTable.connectorAccountId, row.id),
    ))
  const instanceIds = instances.map((entry) => entry.id)

  const mappingRows = instanceIds.length === 0
    ? []
    : await db
      .select({ id: ConnectorMappingTable.id, pluginId: ConnectorMappingTable.pluginId })
      .from(ConnectorMappingTable)
      .where(inArray(ConnectorMappingTable.connectorInstanceId, instanceIds))
  const mappingIds = mappingRows.map((entry) => entry.id)
  const connectorPluginIds = [...new Set(mappingRows.map((entry) => entry.pluginId).filter((value): value is PluginId => Boolean(value)))]

  const configObjectRows = instanceIds.length === 0
    ? []
    : await db
      .select({ id: ConfigObjectTable.id })
      .from(ConfigObjectTable)
      .where(inArray(ConfigObjectTable.connectorInstanceId, instanceIds))
  const configObjectIds = configObjectRows.map((entry) => entry.id)

  await db.transaction(async (tx) => {
    if (instanceIds.length > 0) {
      await tx.delete(ConnectorSourceTombstoneTable).where(inArray(ConnectorSourceTombstoneTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorSourceBindingTable).where(inArray(ConnectorSourceBindingTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorSyncEventTable).where(inArray(ConnectorSyncEventTable.connectorInstanceId, instanceIds))
    }

    if (configObjectIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.id, configObjectIds))
    }

    if (mappingIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.connectorMappingId, mappingIds))
      await tx.delete(ConnectorMappingTable).where(inArray(ConnectorMappingTable.id, mappingIds))
    }

    if (instanceIds.length > 0) {
      await tx.delete(ConnectorTargetTable).where(inArray(ConnectorTargetTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorInstanceAccessGrantTable).where(inArray(ConnectorInstanceAccessGrantTable.connectorInstanceId, instanceIds))
      await tx.delete(ConnectorInstanceTable).where(inArray(ConnectorInstanceTable.id, instanceIds))
    }

    if (connectorPluginIds.length > 0) {
      const remainingMemberships = await tx
        .select({ pluginId: PluginConfigObjectTable.pluginId })
        .from(PluginConfigObjectTable)
        .where(inArray(PluginConfigObjectTable.pluginId, connectorPluginIds))
      const pluginsWithOtherContent = new Set(remainingMemberships.map((entry) => entry.pluginId))
      const pluginIdsToDelete = connectorPluginIds.filter((pluginId) => !pluginsWithOtherContent.has(pluginId))

      if (pluginIdsToDelete.length > 0) {
        await tx.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.pluginId, pluginIdsToDelete))
        await tx.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.pluginId, pluginIdsToDelete))
        await tx.delete(PluginTable).where(inArray(PluginTable.id, pluginIdsToDelete))
      }

      const marketplaceRows = await tx
        .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
        .from(MarketplacePluginTable)
      const marketplacesWithMembers = new Set(marketplaceRows.map((entry) => entry.marketplaceId))
      const orphanMarketplaces = await tx
        .select({ id: MarketplaceTable.id })
        .from(MarketplaceTable)
        .where(eq(MarketplaceTable.organizationId, organizationId))
      const orphanIds = orphanMarketplaces
        .map((entry) => entry.id)
        .filter((marketplaceId) => !marketplacesWithMembers.has(marketplaceId))
      if (orphanIds.length > 0) {
        await tx.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.marketplaceId, orphanIds))
        await tx.delete(MarketplaceTable).where(inArray(MarketplaceTable.id, orphanIds))
      }
    }

    await tx.delete(ConnectorAccountTable).where(eq(ConnectorAccountTable.id, row.id))
  })

  return {
    deletedConfigObjectCount: configObjectIds.length,
    deletedConnectorInstanceCount: instanceIds.length,
    deletedConnectorMappingCount: mappingIds.length,
    disconnectedAccountId: row.id,
    reason: input.reason ?? null,
  }
}

export async function listConnectorInstances(input: { connectorAccountId?: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; pluginId?: PluginId; q?: string; status?: ConnectorInstanceRow["status"] }) {
  const rows = await db
    .select()
    .from(ConnectorInstanceTable)
    .where(eq(ConnectorInstanceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorInstanceTable.updatedAt), desc(ConnectorInstanceTable.id))

  const filtered: ReturnType<typeof serializeConnectorInstance>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "connector_instance" })
    if (!role) continue
    if (input.connectorAccountId && row.connectorAccountId !== input.connectorAccountId) continue
    if (input.status && row.status !== input.status) continue
    if (input.q && !`${row.name}\n${row.remoteId ?? ""}`.toLowerCase().includes(input.q.toLowerCase())) continue
    if (input.pluginId) {
      const mappings = await db
        .select({ id: ConnectorMappingTable.id })
        .from(ConnectorMappingTable)
        .where(and(eq(ConnectorMappingTable.connectorInstanceId, row.id), eq(ConnectorMappingTable.pluginId, input.pluginId)))
        .limit(1)
      if (!mappings[0]) continue
    }
    filtered.push(serializeConnectorInstance(row))
  }

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorInstance(input: { connectorAccountId: ConnectorAccountId; connectorType: ConnectorInstanceRow["connectorType"]; config?: Record<string, unknown>; context: PluginArchActorContext; name: string; remoteId?: string | null }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  const now = new Date()
  const row = {
    connectorAccountId: account.id,
    connectorType: input.connectorType,
    createdAt: now,
    createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
    id: createDenTypeId("connectorInstance"),
    instanceConfigJson: input.config ?? null,
    lastSyncCursor: null,
    lastSyncStatus: null,
    lastSyncedAt: null,
    name: input.name.trim(),
    organizationId: input.context.organizationContext.organization.id,
    remoteId: normalizeOptionalString(input.remoteId ?? undefined),
    status: "active" as const,
    updatedAt: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(ConnectorInstanceTable).values(row)
    await tx.insert(ConnectorInstanceAccessGrantTable).values({
      connectorInstanceId: row.id,
      createdAt: now,
      createdByOrgMembershipId: input.context.organizationContext.currentMember.id,
      id: createDenTypeId("connectorInstanceAccessGrant"),
      organizationId: input.context.organizationContext.organization.id,
      orgMembershipId: input.context.organizationContext.currentMember.id,
      orgWide: false,
      role: "manager",
      teamId: null,
    })
  })
  return serializeConnectorInstance(row)
}

export async function getConnectorInstanceDetail(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await ensureVisibleConnectorInstance(context, connectorInstanceId)
  return serializeConnectorInstance(row)
}

export async function updateConnectorInstance(input: { connectorInstanceId: ConnectorInstanceId; config?: Record<string, unknown>; context: PluginArchActorContext; name?: string; remoteId?: string | null; status?: ConnectorInstanceRow["status"] }) {
  const row = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: input.config === undefined ? row.instanceConfigJson : input.config,
    name: input.name?.trim() || row.name,
    remoteId: input.remoteId === undefined ? row.remoteId : normalizeOptionalString(input.remoteId ?? undefined),
    status: input.status ?? row.status,
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, row.id))
  return getConnectorInstanceDetail(input.context, row.id)
}

export async function setConnectorInstanceLifecycle(input: { action: "archive" | "disable" | "enable"; connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const row = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const status = input.action === "archive" ? "archived" : input.action === "disable" ? "disabled" : "active"
  await db.update(ConnectorInstanceTable).set({ status, updatedAt: new Date() }).where(eq(ConnectorInstanceTable.id, row.id))
  return getConnectorInstanceDetail(input.context, row.id)
}

function commonSelectorRootPath(selectors: string[]): string | null {
  const normalized = selectors
    .map((selector) => {
      let path = selector.trim().replace(/^\/+/, "").replace(/\/+$/, "")
      if (path.endsWith("/**")) {
        path = path.slice(0, -3)
      }
      const knownLeafSegments = ["skills", "commands", "agents", "hooks", "monitors", "mcp", ".mcp.json", ".lsp.json", "settings.json", "hooks.json"]
      for (const leaf of knownLeafSegments) {
        if (path === leaf) return ""
        if (path.endsWith(`/${leaf}`)) return path.slice(0, -(leaf.length + 1))
      }
      return path
    })
    .filter((path): path is string => path !== null)

  if (normalized.length === 0) return null
  if (normalized.every((path) => path === normalized[0])) {
    return normalized[0]
  }

  const parts = normalized[0].split("/")
  for (let index = parts.length; index > 0; index -= 1) {
    const candidate = parts.slice(0, index).join("/")
    if (normalized.every((path) => path === candidate || path.startsWith(`${candidate}/`))) {
      return candidate
    }
  }
  return ""
}

export async function getConnectorInstanceConfiguration(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  const mappings = await db
    .select()
    .from(ConnectorMappingTable)
    .where(eq(ConnectorMappingTable.connectorInstanceId, instance.id))
    .orderBy(desc(ConnectorMappingTable.createdAt), desc(ConnectorMappingTable.id))

  const pluginIds = [...new Set(mappings.map((row) => row.pluginId).filter((value): value is PluginId => Boolean(value)))]
  const pluginRows = pluginIds.length === 0
    ? []
    : await db.select().from(PluginTable).where(inArray(PluginTable.id, pluginIds))
  const memberships = pluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId, configObjectId: PluginConfigObjectTable.configObjectId })
      .from(PluginConfigObjectTable)
      .where(and(inArray(PluginConfigObjectTable.pluginId, pluginIds), isNull(PluginConfigObjectTable.removedAt)))
  const configObjectIds = [...new Set(memberships.map((entry) => entry.configObjectId))]
  const configObjectTypeById = new Map<string, string>()
  if (configObjectIds.length > 0) {
    const rows = await db
      .select({ id: ConfigObjectTable.id, objectType: ConfigObjectTable.objectType })
      .from(ConfigObjectTable)
      .where(inArray(ConfigObjectTable.id, configObjectIds))
    for (const row of rows) {
      configObjectTypeById.set(row.id, row.objectType)
    }
  }

  const pluginComponentCounts = new Map<string, Map<string, number>>()
  const membershipCounts = new Map<string, number>()
  for (const membership of memberships) {
    membershipCounts.set(membership.pluginId, (membershipCounts.get(membership.pluginId) ?? 0) + 1)
    const objectType = configObjectTypeById.get(membership.configObjectId)
    if (!objectType) continue
    let counts = pluginComponentCounts.get(membership.pluginId)
    if (!counts) {
      counts = new Map<string, number>()
      pluginComponentCounts.set(membership.pluginId, counts)
    }
    counts.set(objectType, (counts.get(objectType) ?? 0) + 1)
  }

  const pluginRootPaths = new Map<string, string | null>()
  for (const pluginId of pluginIds) {
    const selectors = mappings
      .filter((mapping) => mapping.pluginId === pluginId)
      .map((mapping) => mapping.selector)
    pluginRootPaths.set(pluginId, commonSelectorRootPath(selectors))
  }

  const configObjectRows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.connectorInstanceId, instance.id))

  const instanceConfig = instance.instanceConfigJson && typeof instance.instanceConfigJson === "object"
    ? instance.instanceConfigJson as Record<string, unknown>
    : {}
  const savedAutoImport = instanceConfig.autoImportNewPlugins

  return {
    autoImportNewPlugins: typeof savedAutoImport === "boolean" ? savedAutoImport : true,
    configuredPlugins: pluginRows.map((row) => ({
      ...serializePlugin(row, membershipCounts.get(row.id) ?? 0),
      componentCounts: Object.fromEntries(pluginComponentCounts.get(row.id) ?? new Map()),
      rootPath: pluginRootPaths.get(row.id) ?? null,
    })),
    connectorInstance: serializeConnectorInstance(instance),
    importedConfigObjectCount: configObjectRows.length,
    mappingCount: mappings.length,
  }
}

export async function setConnectorInstanceAutoImport(input: { autoImportNewPlugins: boolean; connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const currentConfig = instance.instanceConfigJson && typeof instance.instanceConfigJson === "object"
    ? instance.instanceConfigJson as Record<string, unknown>
    : {}
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: {
      ...currentConfig,
      autoImportNewPlugins: input.autoImportNewPlugins,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, instance.id))

  return getConnectorInstanceConfiguration({ connectorInstanceId: instance.id, context: input.context })
}

export async function removeConnectorInstance(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const organizationId = input.context.organizationContext.organization.id
  const instance = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)

  const mappingRows = await db
    .select({ id: ConnectorMappingTable.id, pluginId: ConnectorMappingTable.pluginId })
    .from(ConnectorMappingTable)
    .where(eq(ConnectorMappingTable.connectorInstanceId, instance.id))
  const mappingIds = mappingRows.map((entry) => entry.id)
  const pluginIds = [...new Set(mappingRows.map((entry) => entry.pluginId).filter((value): value is PluginId => Boolean(value)))]

  const configObjectRows = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(eq(ConfigObjectTable.connectorInstanceId, instance.id))
  const configObjectIds = configObjectRows.map((entry) => entry.id)

  await db.transaction(async (tx) => {
    await tx.delete(ConnectorSourceTombstoneTable).where(eq(ConnectorSourceTombstoneTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorSourceBindingTable).where(eq(ConnectorSourceBindingTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.connectorInstanceId, instance.id))

    if (configObjectIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectAccessGrantTable).where(inArray(ConfigObjectAccessGrantTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectVersionTable).where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
      await tx.delete(ConfigObjectTable).where(inArray(ConfigObjectTable.id, configObjectIds))
    }

    if (mappingIds.length > 0) {
      await tx.delete(PluginConfigObjectTable).where(inArray(PluginConfigObjectTable.connectorMappingId, mappingIds))
      await tx.delete(ConnectorMappingTable).where(inArray(ConnectorMappingTable.id, mappingIds))
    }

    await tx.delete(ConnectorTargetTable).where(eq(ConnectorTargetTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorInstanceAccessGrantTable).where(eq(ConnectorInstanceAccessGrantTable.connectorInstanceId, instance.id))
    await tx.delete(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.id, instance.id))

    if (pluginIds.length > 0) {
      const remainingMemberships = await tx
        .select({ pluginId: PluginConfigObjectTable.pluginId })
        .from(PluginConfigObjectTable)
        .where(inArray(PluginConfigObjectTable.pluginId, pluginIds))
      const pluginsWithOtherContent = new Set(remainingMemberships.map((entry) => entry.pluginId))
      const pluginIdsToDelete = pluginIds.filter((pluginId) => !pluginsWithOtherContent.has(pluginId))

      if (pluginIdsToDelete.length > 0) {
        await tx.delete(MarketplacePluginTable).where(inArray(MarketplacePluginTable.pluginId, pluginIdsToDelete))
        await tx.delete(PluginAccessGrantTable).where(inArray(PluginAccessGrantTable.pluginId, pluginIdsToDelete))
        await tx.delete(PluginTable).where(inArray(PluginTable.id, pluginIdsToDelete))
      }

      const marketplaceMembershipRows = await tx
        .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
        .from(MarketplacePluginTable)
      const marketplacesWithMembers = new Set(marketplaceMembershipRows.map((entry) => entry.marketplaceId))
      const orphanMarketplaces = await tx
        .select({ id: MarketplaceTable.id })
        .from(MarketplaceTable)
        .where(eq(MarketplaceTable.organizationId, organizationId))
      const orphanIds = orphanMarketplaces
        .map((entry) => entry.id)
        .filter((marketplaceId) => !marketplacesWithMembers.has(marketplaceId))
      if (orphanIds.length > 0) {
        await tx.delete(MarketplaceAccessGrantTable).where(inArray(MarketplaceAccessGrantTable.marketplaceId, orphanIds))
        await tx.delete(MarketplaceTable).where(inArray(MarketplaceTable.id, orphanIds))
      }
    }
  })

  return {
    deletedConfigObjectCount: configObjectIds.length,
    deletedConnectorMappingCount: mappingIds.length,
    removedConnectorInstanceId: instance.id,
  }
}

export async function listConnectorTargets(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string; targetKind?: ConnectorTargetRow["targetKind"] }) {
  await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  const rows = await db
    .select()
    .from(ConnectorTargetTable)
    .where(eq(ConnectorTargetTable.connectorInstanceId, input.connectorInstanceId))
    .orderBy(desc(ConnectorTargetTable.updatedAt), desc(ConnectorTargetTable.id))

  const filtered = rows
    .filter((row) => !input.targetKind || row.targetKind === input.targetKind)
    .filter((row) => !input.q || `${row.remoteId}\n${row.externalTargetRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorTarget(row))

  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorTarget(input: { config: Record<string, unknown>; connectorInstanceId: ConnectorInstanceId; connectorType: ConnectorTargetRow["connectorType"]; context: PluginArchActorContext; externalTargetRef?: string | null; remoteId: string; targetKind: ConnectorTargetRow["targetKind"] }) {
  await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const row = {
    connectorInstanceId: input.connectorInstanceId,
    connectorType: input.connectorType,
    createdAt: new Date(),
    externalTargetRef: normalizeOptionalString(input.externalTargetRef ?? undefined),
    id: createDenTypeId("connectorTarget"),
    organizationId: input.context.organizationContext.organization.id,
    remoteId: input.remoteId.trim(),
    targetConfigJson: input.config,
    targetKind: input.targetKind,
    updatedAt: new Date(),
  }
  await db.insert(ConnectorTargetTable).values(row)
  return serializeConnectorTarget(row)
}

export async function getConnectorTargetDetail(context: PluginArchActorContext, connectorTargetId: ConnectorTargetId) {
  const target = await getConnectorTargetRow(context.organizationContext.organization.id, connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureVisibleConnectorInstance(context, target.connectorInstanceId)
  return serializeConnectorTarget(target)
}

export async function updateConnectorTarget(input: { config?: Record<string, unknown>; connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; externalTargetRef?: string | null; remoteId?: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  await db.update(ConnectorTargetTable).set({
    externalTargetRef: input.externalTargetRef === undefined ? target.externalTargetRef : normalizeOptionalString(input.externalTargetRef ?? undefined),
    remoteId: input.remoteId?.trim() || target.remoteId,
    targetConfigJson: input.config === undefined ? target.targetConfigJson : input.config,
    updatedAt: new Date(),
  }).where(eq(ConnectorTargetTable.id, target.id))
  return getConnectorTargetDetail(input.context, target.id)
}

export async function queueConnectorTargetResync(input: { connectorTargetId: ConnectorTargetId; context: PluginArchActorContext }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  const instance = await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  const eventId = createDenTypeId("connectorSyncEvent")
  await db.insert(ConnectorSyncEventTable).values({
    completedAt: null,
    connectorInstanceId: instance.id,
    connectorTargetId: target.id,
    connectorType: target.connectorType,
    eventType: "manual_resync",
    externalEventRef: null,
    id: eventId,
    organizationId: instance.organizationId,
    remoteId: target.remoteId,
    sourceRevisionRef: null,
    startedAt: new Date(),
    status: "queued",
    summaryJson: { queuedBy: input.context.organizationContext.currentMember.id },
  })
  return { id: eventId }
}

export async function listConnectorMappings(input: { connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; cursor?: string; limit?: number; mappingKind?: ConnectorMappingRow["mappingKind"]; objectType?: ConnectorMappingRow["objectType"]; pluginId?: PluginId; q?: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureVisibleConnectorInstance(input.context, target.connectorInstanceId)
  const rows = await db.select().from(ConnectorMappingTable).where(eq(ConnectorMappingTable.connectorTargetId, target.id)).orderBy(desc(ConnectorMappingTable.updatedAt), desc(ConnectorMappingTable.id))
  const filtered = rows
    .filter((row) => !input.mappingKind || row.mappingKind === input.mappingKind)
    .filter((row) => !input.objectType || row.objectType === input.objectType)
    .filter((row) => !input.pluginId || row.pluginId === input.pluginId)
    .filter((row) => !input.q || `${row.selector}\n${row.remoteId ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((row) => serializeConnectorMapping(row))
  return pageItems(filtered, input.cursor, input.limit)
}

export async function createConnectorMapping(input: { autoAddToPlugin: boolean; config?: Record<string, unknown>; connectorTargetId: ConnectorTargetId; context: PluginArchActorContext; mappingKind: ConnectorMappingRow["mappingKind"]; objectType: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector: string }) {
  const target = await getConnectorTargetRow(input.context.organizationContext.organization.id, input.connectorTargetId)
  if (!target) throw new PluginArchRouteFailure(404, "connector_target_not_found", "Connector target not found.")
  await ensureEditableConnectorInstance(input.context, target.connectorInstanceId)
  if (input.pluginId) {
    await ensureEditablePlugin(input.context, input.pluginId)
  }
  const row = {
    autoAddToPlugin: input.autoAddToPlugin,
    connectorInstanceId: target.connectorInstanceId,
    connectorTargetId: target.id,
    connectorType: target.connectorType,
    createdAt: new Date(),
    id: createDenTypeId("connectorMapping"),
    mappingConfigJson: input.config ?? null,
    mappingKind: input.mappingKind,
    objectType: input.objectType,
    organizationId: input.context.organizationContext.organization.id,
    pluginId: input.pluginId ?? null,
    remoteId: null,
    selector: input.selector.trim(),
    updatedAt: new Date(),
  }
  await db.insert(ConnectorMappingTable).values(row)
  return serializeConnectorMapping(row)
}

export async function updateConnectorMapping(input: { autoAddToPlugin?: boolean; config?: Record<string, unknown>; connectorMappingId: ConnectorMappingId; context: PluginArchActorContext; objectType?: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector?: string }) {
  const mapping = await getConnectorMappingRow(input.context.organizationContext.organization.id, input.connectorMappingId)
  if (!mapping) throw new PluginArchRouteFailure(404, "connector_mapping_not_found", "Connector mapping not found.")
  await ensureEditableConnectorInstance(input.context, mapping.connectorInstanceId)
  if (input.pluginId) {
    await ensureEditablePlugin(input.context, input.pluginId)
  }
  await db.update(ConnectorMappingTable).set({
    autoAddToPlugin: input.autoAddToPlugin ?? mapping.autoAddToPlugin,
    mappingConfigJson: input.config === undefined ? mapping.mappingConfigJson : input.config,
    objectType: input.objectType ?? mapping.objectType,
    pluginId: input.pluginId === undefined ? mapping.pluginId : input.pluginId,
    selector: input.selector?.trim() || mapping.selector,
    updatedAt: new Date(),
  }).where(eq(ConnectorMappingTable.id, mapping.id))
  return serializeConnectorMapping({ ...mapping, autoAddToPlugin: input.autoAddToPlugin ?? mapping.autoAddToPlugin, mappingConfigJson: input.config === undefined ? mapping.mappingConfigJson : input.config, objectType: input.objectType ?? mapping.objectType, pluginId: input.pluginId === undefined ? mapping.pluginId : input.pluginId, selector: input.selector?.trim() || mapping.selector, updatedAt: new Date() })
}

export async function deleteConnectorMapping(input: { connectorMappingId: ConnectorMappingId; context: PluginArchActorContext }) {
  const mapping = await getConnectorMappingRow(input.context.organizationContext.organization.id, input.connectorMappingId)
  if (!mapping) throw new PluginArchRouteFailure(404, "connector_mapping_not_found", "Connector mapping not found.")
  await ensureEditableConnectorInstance(input.context, mapping.connectorInstanceId)
  await db.delete(ConnectorMappingTable).where(eq(ConnectorMappingTable.id, mapping.id))
}

export async function listConnectorSyncEvents(input: { connectorInstanceId?: ConnectorInstanceId; connectorTargetId?: ConnectorTargetId; context: PluginArchActorContext; cursor?: string; eventType?: ConnectorSyncEventRow["eventType"]; limit?: number; q?: string; status?: ConnectorSyncEventRow["status"] }) {
  const rows = await db
    .select({ event: ConnectorSyncEventTable, instance: ConnectorInstanceTable })
    .from(ConnectorSyncEventTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorSyncEventTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(eq(ConnectorInstanceTable.organizationId, input.context.organizationContext.organization.id))
    .orderBy(desc(ConnectorSyncEventTable.startedAt), desc(ConnectorSyncEventTable.id))

  const filtered: ReturnType<typeof serializeConnectorSyncEvent>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.instance.id, resourceKind: "connector_instance" })
    if (!role) continue
    if (input.connectorInstanceId && row.event.connectorInstanceId !== input.connectorInstanceId) continue
    if (input.connectorTargetId && row.event.connectorTargetId !== input.connectorTargetId) continue
    if (input.eventType && row.event.eventType !== input.eventType) continue
    if (input.status && row.event.status !== input.status) continue
    if (input.q && !`${row.event.externalEventRef ?? ""}\n${row.event.sourceRevisionRef ?? ""}`.toLowerCase().includes(input.q.toLowerCase())) continue
    filtered.push(serializeConnectorSyncEvent(row.event))
  }
  return pageItems(filtered, input.cursor, input.limit)
}

export async function getConnectorSyncEventDetail(context: PluginArchActorContext, connectorSyncEventId: ConnectorSyncEventId) {
  const row = await getConnectorSyncEventRow(context.organizationContext.organization.id, connectorSyncEventId)
  if (!row) throw new PluginArchRouteFailure(404, "connector_sync_event_not_found", "Connector sync event not found.")
  await ensureVisibleConnectorInstance(context, row.connectorInstanceId)
  return serializeConnectorSyncEvent(row)
}

export async function retryConnectorSyncEvent(input: { connectorSyncEventId: ConnectorSyncEventId; context: PluginArchActorContext }) {
  const row = await getConnectorSyncEventRow(input.context.organizationContext.organization.id, input.connectorSyncEventId)
  if (!row) throw new PluginArchRouteFailure(404, "connector_sync_event_not_found", "Connector sync event not found.")
  await ensureEditableConnectorInstance(input.context, row.connectorInstanceId)
  await db.update(ConnectorSyncEventTable).set({ completedAt: null, startedAt: new Date(), status: "queued" }).where(eq(ConnectorSyncEventTable.id, row.id))
  return { id: row.id }
}

function githubConnectorAppConfig() {
  try {
    return getGithubConnectorAppConfig(env.githubConnectorApp)
  } catch (error) {
    if (error instanceof GithubConnectorConfigError) {
      throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
    }
    throw error
  }
}

export function consumeGithubInstallState(state: string) {
  const parsed = verifyGithubInstallStateToken({ secret: env.betterAuthSecret, token: state })
  if (!parsed) {
    throw new PluginArchRouteFailure(400, "invalid_github_install_state", "GitHub install state is invalid or expired.")
  }
  return parsed
}

function wrapGithubConnectorError(error: unknown): never {
  if (error instanceof PluginArchRouteFailure) {
    throw error
  }

  if (error instanceof GithubConnectorConfigError) {
    throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
  }

  if (error instanceof GithubConnectorRequestError) {
    throw new PluginArchRouteFailure(409, "github_connector_request_failed", error.message)
  }

  throw error
}

function normalizeDiscoveryCursor(value: string | undefined) {
  return value?.trim() || undefined
}

function discoveryStep(status: GithubConnectorDiscoveryStep["status"], id: GithubConnectorDiscoveryStep["id"], label: string): GithubConnectorDiscoveryStep {
  return { id, label, status }
}

async function getGithubDiscoveryContext(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const connectorInstance = await ensureVisibleConnectorInstance(input.context, input.connectorInstanceId)
  if (connectorInstance.connectorType !== "github") {
    throw new PluginArchRouteFailure(409, "github_connector_instance_required", "Connector instance is not a GitHub connector.")
  }

  const connectorAccount = await getConnectorAccountRow(input.context.organizationContext.organization.id, connectorInstance.connectorAccountId)
  if (!connectorAccount || connectorAccount.connectorType !== "github") {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "GitHub connector account not found.")
  }

  const targetRows = await db
    .select()
    .from(ConnectorTargetTable)
    .where(eq(ConnectorTargetTable.connectorInstanceId, connectorInstance.id))
    .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))
    .limit(1)
  const connectorTarget = targetRows[0] ?? null
  if (!connectorTarget) {
    throw new PluginArchRouteFailure(404, "connector_target_not_found", "GitHub connector target not found.")
  }

  const targetConfig = connectorTarget.targetConfigJson && typeof connectorTarget.targetConfigJson === "object"
    ? connectorTarget.targetConfigJson as Record<string, unknown>
    : {}
  const repositoryFullName = typeof targetConfig.repositoryFullName === "string" ? targetConfig.repositoryFullName.trim() : connectorTarget.remoteId.trim()
  const branch = typeof targetConfig.branch === "string" ? targetConfig.branch.trim() : connectorTarget.externalTargetRef?.trim() ?? ""
  const ref = typeof targetConfig.ref === "string" ? targetConfig.ref.trim() : branch ? `refs/heads/${branch}` : ""
  const installationId = typeof connectorInstance.instanceConfigJson === "object" && connectorInstance.instanceConfigJson && typeof (connectorInstance.instanceConfigJson as Record<string, unknown>).installationId === "number"
    ? (connectorInstance.instanceConfigJson as Record<string, unknown>).installationId as number
    : Number(connectorAccount.remoteId)

  if (!repositoryFullName || !branch || !ref || !Number.isFinite(installationId) || installationId <= 0) {
    throw new PluginArchRouteFailure(409, "invalid_github_connector_target", "GitHub connector target is missing repository, branch, or installation metadata.")
  }

  const instanceConfigRecord = typeof connectorInstance.instanceConfigJson === "object" && connectorInstance.instanceConfigJson
    ? connectorInstance.instanceConfigJson as Record<string, unknown>
    : null
  const autoImportSaved = instanceConfigRecord ? instanceConfigRecord.autoImportNewPlugins : undefined
  return {
    autoImportNewPlugins: typeof autoImportSaved === "boolean" ? autoImportSaved : true,
    branch,
    connectorAccount,
    connectorInstance,
    connectorTarget,
    installationId,
    ref,
    repositoryFullName,
  }
}

async function buildConnectorAutomationContext(input: { connectorInstance: ConnectorInstanceRow }) {
  const organizationRows = await db
    .select()
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, input.connectorInstance.organizationId))
    .limit(1)
  const organization = organizationRows[0] as OrganizationRow | undefined
  if (!organization) {
    throw new PluginArchRouteFailure(404, "organization_not_found", "Organization not found for connector instance.")
  }

  const memberRows = await db
    .select()
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.connectorInstance.organizationId),
      eq(MemberTable.id, input.connectorInstance.createdByOrgMembershipId),
    ))
    .limit(1)
  const member = memberRows[0] as MemberRow | undefined
  if (!member) {
    throw new PluginArchRouteFailure(404, "member_not_found", "Connector creator member not found.")
  }

  return {
    memberTeams: [],
    organizationContext: {
      currentMember: {
        createdAt: member.createdAt,
        id: member.id,
        isOwner: roleIncludesOwner(member.role),
        role: member.role,
        userId: member.userId,
      },
      invitations: [],
      members: [],
      organization: {
        allowedEmailDomains: organization.allowedEmailDomains ?? null,
        createdAt: organization.createdAt,
        desktopAppRestrictions: organization.desktopAppRestrictions,
        id: organization.id,
        logo: organization.logo ?? null,
        metadata: organization.metadata ? JSON.stringify(organization.metadata) : null,
        name: organization.name,
        slug: organization.slug,
        updatedAt: organization.updatedAt,
      },
      roles: [],
      teams: [],
    },
  } satisfies PluginArchActorContext
}

async function maybeAutoImportGithubConnectorInstance(input: {
  connectorInstance: ConnectorInstanceRow
  connectorTarget: ConnectorTargetRow
}) {
  const instanceConfig = input.connectorInstance.instanceConfigJson && typeof input.connectorInstance.instanceConfigJson === "object"
    ? input.connectorInstance.instanceConfigJson as Record<string, unknown>
    : {}
  if (instanceConfig.autoImportNewPlugins !== true) {
    return { autoImported: false as const, createdPluginCount: 0, materializedConfigObjectCount: 0 }
  }

  const context = await buildConnectorAutomationContext({ connectorInstance: input.connectorInstance })
  const discovery = await computeGithubConnectorDiscovery({
    connectorInstanceId: input.connectorInstance.id,
    context,
  })
  const selectedKeys = discovery.discoveredPlugins
    .filter((plugin) => plugin.supported)
    .map((plugin) => plugin.key)

  const applied = await applyGithubConnectorDiscovery({
    autoImportNewPlugins: true,
    connectorInstanceId: input.connectorInstance.id,
    context,
    selectedKeys,
  })

  return {
    autoImported: true as const,
    createdPluginCount: applied.createdPlugins.length,
    materializedConfigObjectCount: applied.materializedConfigObjects.length,
  }
}

async function getGithubDiscoveryFileTexts(input: {
  branch: string
  config: ReturnType<typeof githubConnectorAppConfig>
  installationId: number
  repositoryFullName: string
  treeEntries: GithubDiscoveryTreeEntry[]
}) {
  const interestingPaths = new Set<string>()
  const knownPaths = new Set(input.treeEntries.map((entry) => entry.path))

  if (knownPaths.has(".claude-plugin/marketplace.json")) {
    interestingPaths.add(".claude-plugin/marketplace.json")
  }

  for (const entry of input.treeEntries) {
    if (entry.path.endsWith(".claude-plugin/plugin.json") || entry.path.endsWith("/plugin.json") || entry.path === "plugin.json") {
      interestingPaths.add(entry.path)
    }
  }

  const fileTextByPath: Record<string, string | null> = {}
  for (const path of interestingPaths) {
    try {
      fileTextByPath[path] = await getGithubRepositoryTextFile({
        config: input.config,
        installationId: input.installationId,
        path,
        ref: input.branch,
        repositoryFullName: input.repositoryFullName,
      })
    } catch (error) {
      wrapGithubConnectorError(error)
    }
  }

  return fileTextByPath
}

function pagedGithubDiscoveryTree(input: { cursor?: string; entries: GithubDiscoveryTreeEntry[]; limit?: number; prefix?: string }) {
  const normalizedPrefix = input.prefix?.trim().replace(/^\/+/, "").replace(/\/+$/, "")
  const filtered = input.entries
    .filter((entry) => !normalizedPrefix || entry.path === normalizedPrefix || entry.path.startsWith(`${normalizedPrefix}/`))
    .sort((left, right) => left.path.localeCompare(right.path))
  return pageItems(filtered, normalizeDiscoveryCursor(input.cursor), input.limit)
}

async function computeGithubConnectorDiscovery(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const discoveryContext = await getGithubDiscoveryContext(input)
  let treeSnapshot: Awaited<ReturnType<typeof getGithubRepositoryTree>>
  try {
    treeSnapshot = await getGithubRepositoryTree({
      branch: discoveryContext.branch,
      config: githubConnectorAppConfig(),
      installationId: discoveryContext.installationId,
      repositoryFullName: discoveryContext.repositoryFullName,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }

  const fileTextByPath = await getGithubDiscoveryFileTexts({
    branch: discoveryContext.branch,
    config: githubConnectorAppConfig(),
    installationId: discoveryContext.installationId,
    repositoryFullName: discoveryContext.repositoryFullName,
    treeEntries: treeSnapshot.treeEntries,
  })
  const discovery = buildGithubRepoDiscovery({
    entries: treeSnapshot.treeEntries,
    fileTextByPath,
  })

  const steps: GithubConnectorDiscoveryStep[] = [
    discoveryStep("completed", "read_repository_structure", "Read repository structure"),
    discoveryStep(treeSnapshot.treeEntries.some((entry) => entry.path === ".claude-plugin/marketplace.json") ? "completed" : "warning", "check_marketplace_manifest", "Check for Claude marketplace manifest"),
    discoveryStep(discovery.classification === "claude_single_plugin_repo" || discovery.classification === "claude_multi_plugin_repo" ? "completed" : "warning", "check_plugin_manifests", "Check for plugin manifests"),
    discoveryStep(discovery.discoveredPlugins.length > 0 ? "completed" : "warning", "prepare_discovered_plugins", "Prepare discovered plugins"),
  ]

  return {
    autoImportNewPlugins: discoveryContext.autoImportNewPlugins,
    classification: discovery.classification,
    connectorInstance: serializeConnectorInstance(discoveryContext.connectorInstance),
    connectorTarget: serializeConnectorTarget(discoveryContext.connectorTarget),
    discoveredPlugins: discovery.discoveredPlugins,
    marketplace: discovery.marketplace,
    repositoryFullName: discoveryContext.repositoryFullName,
    sourceRevisionRef: treeSnapshot.headSha,
    steps,
    treeEntries: treeSnapshot.treeEntries,
    treeSummary: {
      scannedEntryCount: treeSnapshot.treeEntries.length,
      strategy: "git-tree-recursive",
      truncated: treeSnapshot.truncated,
    } satisfies GithubConnectorDiscoveryTreeSummary,
    warnings: discovery.warnings,
  }
}

function discoveryMappingsForPlugin(plugin: GithubDiscoveredPlugin) {
  return [
    ...plugin.componentPaths.skills.map((selector) => ({ objectType: "skill" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.commands.map((selector) => ({ objectType: "command" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.agents.map((selector) => ({ objectType: "agent" as const, selector: `${selector}/**` })),
    ...plugin.componentPaths.hooks.map((selector) => ({ objectType: "hook" as const, selector })),
    ...plugin.componentPaths.mcpServers.map((selector) => ({ objectType: "mcp" as const, selector })),
  ]
}

function mappingSelectorMatchesPath(selector: string, path: string) {
  const normalizedSelector = selector.trim().replace(/^\/+/, "")
  const normalizedPath = path.trim().replace(/^\/+/, "")
  if (normalizedSelector.endsWith("/**")) {
    const prefix = normalizedSelector.slice(0, -3)
    return normalizedPath.startsWith(`${prefix}/`)
  }
  return normalizedPath === normalizedSelector
}

function importableGithubPathsForMapping(input: { mapping: ReturnType<typeof serializeConnectorMapping>; treeEntries: GithubDiscoveryTreeEntry[] }) {
  const matchingBlobs = input.treeEntries
    .filter((entry) => entry.kind === "blob")
    .filter((entry) => mappingSelectorMatchesPath(input.mapping.selector, entry.path))

  if (input.mapping.objectType === "skill") {
    const preferred = matchingBlobs.filter((entry) => entry.path.endsWith("/SKILL.md"))
    return preferred.length > 0 ? preferred : matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  if (input.mapping.objectType === "agent") {
    const preferred = matchingBlobs.filter((entry) => entry.path.endsWith("/AGENT.md"))
    return preferred.length > 0 ? preferred : matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  if (input.mapping.objectType === "command") {
    return matchingBlobs.filter((entry) => entry.path.endsWith(".md"))
  }
  return matchingBlobs
}

function parseMarkdownFrontmatter(rawSourceText: string): { body: string; data: Record<string, string> } {
  const match = rawSourceText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { body: rawSourceText, data: {} }
  }

  const [, yaml, body] = match
  const data: Record<string, string> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colonIndex = trimmed.indexOf(":")
    if (colonIndex === -1) continue
    const key = trimmed.slice(0, colonIndex).trim()
    let value = trimmed.slice(colonIndex + 1).trim()
    if (value.length > 1) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    if (!key || !value) continue
    data[key] = value
  }
  return { body: body ?? "", data }
}

function importedObjectMetadata(input: { objectType: ConnectorMappingRow["objectType"]; path: string; rawSourceText: string }) {
  const pathSegments = input.path.split("/")
  const fileName = pathSegments[pathSegments.length - 1] ?? input.path
  const parentName = pathSegments[pathSegments.length - 2] ?? pathSegments[pathSegments.length - 1] ?? "Imported"
  const nameFromFile = fileName.replace(/\.[^.]+$/, "")
  const preferredName = input.objectType === "skill" || input.objectType === "agent"
    ? (fileName.toUpperCase() === "SKILL.MD" || fileName.toUpperCase() === "AGENT.MD" ? parentName : nameFromFile)
    : nameFromFile

  const isMarkdown = fileName.toLowerCase().endsWith(".md") || fileName.toLowerCase().endsWith(".mdx")
  const frontmatter = isMarkdown ? parseMarkdownFrontmatter(input.rawSourceText) : null
  const frontmatterName = frontmatter?.data.name ?? frontmatter?.data.title
  const frontmatterDescription = frontmatter?.data.description ?? frontmatter?.data.summary

  const metadata: Record<string, unknown> = {
    name: frontmatterName?.trim() || preferredName,
    relativePath: input.path,
  }
  if (frontmatterDescription?.trim()) {
    metadata.description = frontmatterDescription.trim()
  }
  if (frontmatter && Object.keys(frontmatter.data).length > 0) {
    metadata.frontmatter = frontmatter.data
  }

  return {
    metadata,
    normalizedPayloadJson: (() => {
      if (!fileName.endsWith(".json")) {
        return undefined
      }
      try {
        const parsed = JSON.parse(input.rawSourceText) as unknown
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
      } catch {
        return undefined
      }
    })(),
  }
}

async function materializeGithubImportedObject(input: {
  connectorInstance: ReturnType<typeof serializeConnectorInstance>
  connectorMapping: ReturnType<typeof serializeConnectorMapping>
  connectorTarget: ReturnType<typeof serializeConnectorTarget>
  context: PluginArchActorContext
  externalLocator: string
  rawSourceText: string
  sourceRevisionRef: string
}) {
  const organizationId = input.context.organizationContext.organization.id
  const createdByOrgMembershipId = input.context.organizationContext.currentMember.id
  const now = new Date()
  const metadata = importedObjectMetadata({
    objectType: input.connectorMapping.objectType,
    path: input.externalLocator,
    rawSourceText: input.rawSourceText,
  })
  const frontmatterRecord = metadata.metadata && typeof metadata.metadata.frontmatter === "object"
    ? metadata.metadata.frontmatter as Record<string, unknown>
    : null
  const hasFrontmatter = frontmatterRecord && Object.keys(frontmatterRecord).length > 0
  const projectionRawSource = hasFrontmatter
    ? parseMarkdownFrontmatter(input.rawSourceText).body
    : input.rawSourceText
  const projection = deriveProjection({
    objectType: input.connectorMapping.objectType,
    value: {
      metadata: metadata.metadata,
      normalizedPayloadJson: metadata.normalizedPayloadJson,
      rawSourceText: projectionRawSource,
    },
  })
  const fileName = input.externalLocator.split("/").filter(Boolean).at(-1) ?? input.externalLocator
  const fileExtension = fileName.includes(".") ? fileName.split(".").at(-1) ?? null : null

  const existingBinding = await db
    .select()
    .from(ConnectorSourceBindingTable)
    .where(and(
      eq(ConnectorSourceBindingTable.organizationId, organizationId),
      eq(ConnectorSourceBindingTable.connectorMappingId, input.connectorMapping.id),
      eq(ConnectorSourceBindingTable.externalLocator, input.externalLocator),
      isNull(ConnectorSourceBindingTable.deletedAt),
    ))
    .limit(1)

  if (!existingBinding[0]) {
    const configObjectId = createDenTypeId("configObject")
    const versionId = createDenTypeId("configObjectVersion")
    await db.transaction(async (tx) => {
      await tx.insert(ConfigObjectTable).values({
        connectorInstanceId: input.connectorInstance.id,
        createdAt: now,
        createdByOrgMembershipId,
        currentFileExtension: normalizeOptionalString(fileExtension ?? undefined),
        currentFileName: fileName,
        currentRelativePath: input.externalLocator,
        deletedAt: null,
        description: projection.description,
        id: configObjectId,
        objectType: input.connectorMapping.objectType,
        organizationId,
        searchText: projection.searchText,
        sourceMode: "connector",
        status: "active",
        title: projection.title,
        updatedAt: now,
      })

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId,
        connectorSyncEventId: null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: "connector",
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: metadata.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.rawSourceText),
        schemaVersion: null,
        sourceRevisionRef: input.sourceRevisionRef,
      })

      await tx.insert(ConfigObjectAccessGrantTable).values({
        configObjectId,
        createdAt: now,
        createdByOrgMembershipId,
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        orgMembershipId: createdByOrgMembershipId,
        orgWide: false,
        role: "manager",
        teamId: null,
      })

      if (input.connectorMapping.pluginId) {
        await tx.insert(PluginConfigObjectTable).values({
          configObjectId,
          connectorMappingId: input.connectorMapping.id,
          createdAt: now,
          createdByOrgMembershipId,
          id: createDenTypeId("pluginConfigObject"),
          membershipSource: "connector",
          organizationId,
          pluginId: input.connectorMapping.pluginId,
          removedAt: null,
        })
      }

      await tx.insert(ConnectorSourceBindingTable).values({
        configObjectId,
        connectorInstanceId: input.connectorInstance.id,
        connectorMappingId: input.connectorMapping.id,
        connectorTargetId: input.connectorTarget.id,
        connectorType: input.connectorTarget.connectorType,
        createdAt: now,
        deletedAt: null,
        externalLocator: input.externalLocator,
        externalStableRef: input.externalLocator,
        id: createDenTypeId("connectorSourceBinding"),
        lastSeenSourceRevisionRef: input.sourceRevisionRef,
        organizationId,
        remoteId: input.connectorTarget.remoteId,
        status: "active",
        updatedAt: now,
      })
    })

    return getConfigObjectDetail(input.context, configObjectId)
  }

  const binding = existingBinding[0]
  if (binding.lastSeenSourceRevisionRef !== input.sourceRevisionRef) {
    const versionId = createDenTypeId("configObjectVersion")
    await db.transaction(async (tx) => {
      await tx.update(ConfigObjectTable).set({
        currentFileExtension: normalizeOptionalString(fileExtension ?? undefined),
        currentFileName: fileName,
        currentRelativePath: input.externalLocator,
        description: projection.description,
        searchText: projection.searchText,
        status: "active",
        title: projection.title,
        updatedAt: now,
      }).where(eq(ConfigObjectTable.id, binding.configObjectId))

      await tx.insert(ConfigObjectVersionTable).values({
        configObjectId: binding.configObjectId,
        connectorSyncEventId: null,
        createdAt: now,
        createdByOrgMembershipId,
        createdVia: "connector",
        id: versionId,
        isDeletedVersion: false,
        normalizedPayloadJson: metadata.normalizedPayloadJson ?? null,
        organizationId,
        rawSourceText: normalizeOptionalString(input.rawSourceText),
        schemaVersion: null,
        sourceRevisionRef: input.sourceRevisionRef,
      })

      if (input.connectorMapping.pluginId) {
        const membership = await tx
          .select({ id: PluginConfigObjectTable.id })
          .from(PluginConfigObjectTable)
          .where(and(
            eq(PluginConfigObjectTable.pluginId, input.connectorMapping.pluginId),
            eq(PluginConfigObjectTable.configObjectId, binding.configObjectId),
          ))
          .limit(1)
        if (membership[0]) {
          await tx.update(PluginConfigObjectTable).set({
            connectorMappingId: input.connectorMapping.id,
            membershipSource: "connector",
            removedAt: null,
          }).where(eq(PluginConfigObjectTable.id, membership[0].id))
        } else {
          await tx.insert(PluginConfigObjectTable).values({
            configObjectId: binding.configObjectId,
            connectorMappingId: input.connectorMapping.id,
            createdAt: now,
            createdByOrgMembershipId,
            id: createDenTypeId("pluginConfigObject"),
            membershipSource: "connector",
            organizationId,
            pluginId: input.connectorMapping.pluginId,
            removedAt: null,
          })
        }
      }

      await tx.update(ConnectorSourceBindingTable).set({
        deletedAt: null,
        lastSeenSourceRevisionRef: input.sourceRevisionRef,
        status: "active",
        updatedAt: now,
      }).where(eq(ConnectorSourceBindingTable.id, binding.id))
    })
  }

  return getConfigObjectDetail(input.context, binding.configObjectId)
}

async function materializeGithubMappings(input: {
  connectorInstance: ReturnType<typeof serializeConnectorInstance>
  connectorTarget: ReturnType<typeof serializeConnectorTarget>
  context: PluginArchActorContext
  mappings: Array<ReturnType<typeof serializeConnectorMapping>>
  sourceRevisionRef: string
  treeEntries: GithubDiscoveryTreeEntry[]
}) {
  const config = githubConnectorAppConfig()
  const targetConfig = input.connectorTarget.targetConfigJson && typeof input.connectorTarget.targetConfigJson === "object"
    ? input.connectorTarget.targetConfigJson as Record<string, unknown>
    : {}
  const branch = typeof targetConfig.branch === "string" ? targetConfig.branch : input.connectorTarget.externalTargetRef ?? ""
  const installationId = typeof input.connectorInstance.instanceConfigJson === "object" && input.connectorInstance.instanceConfigJson && typeof (input.connectorInstance.instanceConfigJson as Record<string, unknown>).installationId === "number"
    ? (input.connectorInstance.instanceConfigJson as Record<string, unknown>).installationId as number
    : null
  const repositoryFullName = typeof targetConfig.repositoryFullName === "string" ? targetConfig.repositoryFullName : input.connectorTarget.remoteId
  if (!installationId || !branch || !repositoryFullName) {
    throw new PluginArchRouteFailure(409, "invalid_github_materialization_context", "GitHub connector target is missing required materialization context.")
  }

  const materializedConfigObjects: ReturnType<typeof serializeConfigObject>[] = []
  for (const mapping of input.mappings) {
    const importableFiles = importableGithubPathsForMapping({ mapping, treeEntries: input.treeEntries })
    for (const file of importableFiles) {
      let rawSourceText: string | null
      try {
        rawSourceText = await getGithubRepositoryTextFile({
          config,
          installationId,
          path: file.path,
          ref: branch,
          repositoryFullName,
        })
      } catch (error) {
        wrapGithubConnectorError(error)
      }
      if (!rawSourceText) {
        continue
      }
      materializedConfigObjects.push(await materializeGithubImportedObject({
        connectorInstance: input.connectorInstance,
        connectorMapping: mapping,
        connectorTarget: input.connectorTarget,
        context: input.context,
        externalLocator: file.path,
        rawSourceText,
        sourceRevisionRef: input.sourceRevisionRef,
      }))
    }
  }

  return materializedConfigObjects
}

async function ensureDiscoveryPlugin(input: { context: PluginArchActorContext; description: string | null; name: string }) {
  const existing = await db
    .select()
    .from(PluginTable)
    .where(and(
      eq(PluginTable.organizationId, input.context.organizationContext.organization.id),
      eq(PluginTable.name, input.name.trim()),
      isNull(PluginTable.deletedAt),
    ))
    .orderBy(asc(PluginTable.createdAt), asc(PluginTable.id))
    .limit(1)

  if (existing[0]) {
    return serializePlugin(existing[0], 0)
  }

  return createPlugin({
    context: input.context,
    description: input.description,
    name: input.name,
  })
}

async function ensureDiscoveryMarketplace(input: { context: PluginArchActorContext; description: string | null; name: string }) {
  const existing = await db
    .select()
    .from(MarketplaceTable)
    .where(and(
      eq(MarketplaceTable.organizationId, input.context.organizationContext.organization.id),
      eq(MarketplaceTable.name, input.name.trim()),
      isNull(MarketplaceTable.deletedAt),
    ))
    .orderBy(asc(MarketplaceTable.createdAt), asc(MarketplaceTable.id))
    .limit(1)

  if (existing[0]) {
    return serializeMarketplace(existing[0], 0)
  }

  return createMarketplace({
    context: input.context,
    description: input.description,
    name: input.name,
  })
}

async function ensureDiscoveryMapping(input: {
  connectorTargetId: ConnectorTargetId
  context: PluginArchActorContext
  objectType: ConnectorMappingRow["objectType"]
  pluginId: PluginId
  selector: string
}) {
  const existing = await db
    .select()
    .from(ConnectorMappingTable)
    .where(and(
      eq(ConnectorMappingTable.connectorTargetId, input.connectorTargetId),
      eq(ConnectorMappingTable.mappingKind, "path"),
      eq(ConnectorMappingTable.objectType, input.objectType),
      eq(ConnectorMappingTable.pluginId, input.pluginId),
      eq(ConnectorMappingTable.selector, input.selector),
    ))
    .limit(1)

  if (existing[0]) {
    return serializeConnectorMapping(existing[0])
  }

  return createConnectorMapping({
    autoAddToPlugin: true,
    config: {
      discoverySourceKind: input.objectType,
    },
    connectorTargetId: input.connectorTargetId,
    context: input.context,
    mappingKind: "path",
    objectType: input.objectType,
    pluginId: input.pluginId,
    selector: input.selector,
  })
}

export async function createGithubConnectorAccount(input: { accountLogin: string; accountType: "Organization" | "User"; context: PluginArchActorContext; displayName: string; installationId: number }) {
  return createConnectorAccount({
    connectorType: "github",
    context: input.context,
    displayName: input.displayName,
    metadata: {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositories: [],
      repositorySelection: "all",
      settingsUrl: null,
    },
    remoteId: String(input.installationId),
  })
}

async function upsertGithubConnectorAccountFromInstallation(input: { context: PluginArchActorContext; installationId: number }) {
  let installation: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    installation = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId: input.installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const organizationId = input.context.organizationContext.organization.id
  const existingRows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(
      eq(ConnectorAccountTable.organizationId, organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(input.installationId)),
    ))
    .limit(1)

  const metadata = {
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositories: [],
    repositorySelection: installation.repositorySelection,
    settingsUrl: installation.settingsUrl,
  }

  if (!existingRows[0]) {
    return createConnectorAccount({
      connectorType: "github",
      context: input.context,
      displayName: installation.displayName,
      externalAccountRef: installation.accountLogin,
      metadata,
      remoteId: String(input.installationId),
    })
  }

  await db.update(ConnectorAccountTable).set({
    displayName: installation.displayName,
    externalAccountRef: installation.accountLogin,
    metadataJson: {
      ...(existingRows[0].metadataJson ?? {}),
      ...metadata,
    },
    status: "active",
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, existingRows[0].id))

  return getConnectorAccountDetail(input.context, existingRows[0].id)
}

export async function startGithubConnectorInstall(input: { context: PluginArchActorContext; returnPath: string }) {
  const returnPath = input.returnPath.trim()
  if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
    throw new PluginArchRouteFailure(400, "invalid_return_path", "GitHub install return path must be a safe relative path.")
  }

  let app: Awaited<ReturnType<typeof getGithubAppSummary>>
  try {
    app = await getGithubAppSummary({ config: githubConnectorAppConfig() })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
  const state = createGithubInstallStateToken({
    orgId: input.context.organizationContext.organization.id,
    returnPath,
    secret: env.betterAuthSecret,
    userId: input.context.organizationContext.currentMember.userId,
  })

  return {
    redirectUrl: buildGithubAppInstallUrl({ app, state }),
    state,
  }
}

export async function completeGithubConnectorInstall(input: { context: PluginArchActorContext; installationId: number; state: string }) {
  const parsedState = consumeGithubInstallState(input.state)
  if (parsedState.orgId !== input.context.organizationContext.organization.id) {
    throw new PluginArchRouteFailure(409, "github_install_org_mismatch", "GitHub install state does not match the current organization.")
  }
  if (parsedState.userId !== input.context.organizationContext.currentMember.userId) {
    throw new PluginArchRouteFailure(409, "github_install_user_mismatch", "GitHub install state does not match the current user.")
  }

  const connectorAccount = await upsertGithubConnectorAccountFromInstallation({
    context: input.context,
    installationId: input.installationId,
  })
  const repositories = await listGithubRepositories({
    connectorAccountId: connectorAccount.id,
    context: input.context,
    limit: 100,
  })

  return {
    connectorAccount,
    repositories: repositories.items,
  }
}

export async function getGithubConnectorDiscovery(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const discovery = await computeGithubConnectorDiscovery(input)
  return {
    classification: discovery.classification,
    connectorInstance: discovery.connectorInstance,
    connectorTarget: discovery.connectorTarget,
    discoveredPlugins: discovery.discoveredPlugins,
    repositoryFullName: discovery.repositoryFullName,
    sourceRevisionRef: discovery.sourceRevisionRef,
    steps: discovery.steps,
    treeSummary: discovery.treeSummary,
    warnings: discovery.warnings,
  }
}

export async function getGithubConnectorDiscoveryTree(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; cursor?: string; limit?: number; prefix?: string }) {
  const discovery = await computeGithubConnectorDiscovery({ connectorInstanceId: input.connectorInstanceId, context: input.context })
  return pagedGithubDiscoveryTree({
    cursor: input.cursor,
    entries: discovery.treeEntries,
    limit: input.limit,
    prefix: input.prefix,
  })
}

export async function applyGithubConnectorDiscovery(input: { autoImportNewPlugins: boolean; connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext; selectedKeys: string[] }) {
  const discovery = await computeGithubConnectorDiscovery({ connectorInstanceId: input.connectorInstanceId, context: input.context })
  const selectedKeySet = new Set(input.selectedKeys.map((key) => key.trim()).filter(Boolean))
  const selectedPlugins = discovery.discoveredPlugins.filter((plugin) => plugin.supported && selectedKeySet.has(plugin.key))
  await db.update(ConnectorInstanceTable).set({
    instanceConfigJson: {
      ...((discovery.connectorInstance.instanceConfigJson && typeof discovery.connectorInstance.instanceConfigJson === "object")
        ? discovery.connectorInstance.instanceConfigJson as Record<string, unknown>
        : {}),
      autoImportNewPlugins: input.autoImportNewPlugins,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorInstanceTable.id, discovery.connectorInstance.id))

  const marketplaceInfo = discovery.marketplace
  const marketplaceName = marketplaceInfo?.name?.trim() || discovery.repositoryFullName
  const marketplaceDescription = marketplaceInfo?.description?.trim()
    ?? `Imported from GitHub marketplace repository ${discovery.repositoryFullName}.`
  const createdMarketplace = discovery.classification === "claude_marketplace_repo"
    ? await ensureDiscoveryMarketplace({
        context: input.context,
        description: marketplaceDescription,
        name: marketplaceName,
      })
    : null

  const plugins = [] as Array<ReturnType<typeof serializePlugin>>
  const mappings = [] as Array<ReturnType<typeof serializeConnectorMapping>>
  for (const discoveredPlugin of selectedPlugins) {
    const plugin = await ensureDiscoveryPlugin({
      context: input.context,
      description: discoveredPlugin.description,
      name: discoveredPlugin.displayName,
    })
    plugins.push(plugin)

    if (createdMarketplace) {
      await attachPluginToMarketplace({
        context: input.context,
        marketplaceId: createdMarketplace.id,
        membershipSource: "connector",
        pluginId: plugin.id,
      })
    }

    for (const mapping of discoveryMappingsForPlugin(discoveredPlugin)) {
      mappings.push(await ensureDiscoveryMapping({
        connectorTargetId: discovery.connectorTarget.id,
        context: input.context,
        objectType: mapping.objectType,
        pluginId: plugin.id,
        selector: mapping.selector,
      }))
    }
  }

  const materializedConfigObjects = await materializeGithubMappings({
    connectorInstance: discovery.connectorInstance,
    connectorTarget: discovery.connectorTarget,
    context: input.context,
    mappings,
    sourceRevisionRef: discovery.sourceRevisionRef,
    treeEntries: discovery.treeEntries,
  })

  return {
    autoImportNewPlugins: input.autoImportNewPlugins,
    createdMarketplace,
    connectorInstance: discovery.connectorInstance,
    connectorTarget: discovery.connectorTarget,
    createdPlugins: plugins,
    createdMappings: mappings,
    materializedConfigObjects,
    sourceRevisionRef: discovery.sourceRevisionRef,
  }
}

export async function listGithubRepositories(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  if (account.connectorType !== "github") {
    throw new PluginArchRouteFailure(409, "github_connector_account_required", "Connector account is not a GitHub account.")
  }

  const installationId = Number(account.remoteId)
  if (!Number.isFinite(installationId) || installationId <= 0) {
    throw new PluginArchRouteFailure(409, "invalid_github_installation_id", "Connector account does not have a valid GitHub installation id.")
  }

  let repositories: RepositorySummary[]
  let installationSummary: Awaited<ReturnType<typeof getGithubInstallationSummary>>
  try {
    repositories = await listGithubInstallationRepositories({
      config: githubConnectorAppConfig(),
      installationId,
    })
    installationSummary = await getGithubInstallationSummary({
      config: githubConnectorAppConfig(),
      installationId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }

  const existingMetadata = account.metadataJson && typeof account.metadataJson === "object"
    ? account.metadataJson as Record<string, unknown>
    : {}
  await db.update(ConnectorAccountTable).set({
    metadataJson: {
      ...existingMetadata,
      repositories: repositories.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        id: repository.id,
        private: repository.private,
      })),
      repositorySelection: installationSummary.repositorySelection,
      settingsUrl: installationSummary.settingsUrl,
    },
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, account.id))

  const filtered = repositories
    .filter((repository) => !input.q || `${repository.fullName}\n${repository.defaultBranch ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((repository) => ({ ...repository, id: String(repository.id) }))
  const page = pageItems(filtered, input.cursor, input.limit)
  return {
    items: page.items.map((repository) => ({
      defaultBranch: repository.defaultBranch,
      fullName: repository.fullName,
      hasPluginManifest: Boolean(repository.hasPluginManifest),
      id: Number(repository.id),
      manifestKind: repository.manifestKind ?? null,
      marketplacePluginCount: repository.marketplacePluginCount ?? null,
      private: repository.private,
    })),
    nextCursor: page.nextCursor,
  }
}

export async function validateGithubTarget(input: { branch: string; installationId: number; ref: string; repositoryFullName: string; repositoryId: number }) {
  try {
    return await validateGithubInstallationTarget({
      branch: input.branch,
      config: githubConnectorAppConfig(),
      installationId: input.installationId,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
    })
  } catch (error) {
    wrapGithubConnectorError(error)
  }
}

export async function githubSetup(input: {
  branch: string
  connectorAccountId?: ConnectorAccountId
  connectorInstanceName: string
  context: PluginArchActorContext
  installationId: number
  mappings: Array<{ autoAddToPlugin: boolean; config?: Record<string, unknown>; mappingKind: ConnectorMappingRow["mappingKind"]; objectType: ConnectorMappingRow["objectType"]; pluginId?: PluginId | null; selector: string }>
  ref: string
  repositoryFullName: string
  repositoryId: number
}) {
  const validation = await validateGithubTarget({
    branch: input.branch,
    installationId: input.installationId,
    ref: input.ref,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
  })
  if (!validation.repositoryAccessible) {
    throw new PluginArchRouteFailure(409, "github_repository_not_accessible", "GitHub repository is not accessible for this installation.")
  }
  if (!validation.branchExists) {
    throw new PluginArchRouteFailure(409, "github_branch_not_found", "GitHub branch/ref could not be validated for this repository.")
  }

  let connectorAccountId = input.connectorAccountId as ConnectorAccountId | undefined
  let connectorAccountDetail = connectorAccountId ? await getConnectorAccountDetail(input.context, connectorAccountId) : null
  if (!connectorAccountId || !connectorAccountDetail) {
    connectorAccountDetail = await createGithubConnectorAccount({
      accountLogin: input.repositoryFullName.split("/")[0] ?? input.repositoryFullName,
      accountType: "Organization",
      context: input.context,
      displayName: input.repositoryFullName,
      installationId: input.installationId,
    })
    connectorAccountId = connectorAccountDetail.id
  }

  const connectorInstance = await createConnectorInstance({
    connectorAccountId,
    connectorType: "github",
    config: {
      autoImportNewPlugins: true,
      installationId: input.installationId,
    },
    context: input.context,
    name: input.connectorInstanceName,
    remoteId: input.repositoryFullName,
  })

  const connectorTarget = await createConnectorTarget({
    config: {
      branch: input.branch,
      defaultBranch: validation.defaultBranch,
      ref: input.ref,
      repositoryFullName: input.repositoryFullName,
      repositoryId: input.repositoryId,
    },
    connectorInstanceId: connectorInstance.id,
    connectorType: "github",
    context: input.context,
    externalTargetRef: input.branch,
    remoteId: input.repositoryFullName,
    targetKind: "repository_branch",
  })

  for (const mapping of input.mappings) {
    await createConnectorMapping({
      autoAddToPlugin: mapping.autoAddToPlugin,
      config: mapping.config,
      connectorTargetId: connectorTarget.id,
      context: input.context,
      mappingKind: mapping.mappingKind,
      objectType: mapping.objectType,
      pluginId: mapping.pluginId,
      selector: mapping.selector,
    })
  }

  return {
    connectorAccount: connectorAccountDetail,
    connectorInstance,
    connectorTarget,
  }
}

export async function enqueueGithubWebhookSync(input: {
  deliveryId: string
  event: "installation" | "installation_repositories" | "push" | "repository"
  headSha?: string
  installationId?: number
  payload: Record<string, unknown>
  ref?: string
  repositoryFullName?: string
  repositoryId?: number
}) {
  if (!input.installationId) {
    return { accepted: false as const, reason: "missing installation id" }
  }

  const accounts = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.connectorType, "github"), eq(ConnectorAccountTable.remoteId, String(input.installationId))))

  if (input.event !== "push") {
    if (input.event === "installation") {
      const action = typeof input.payload.action === "string" ? input.payload.action : null
      if (action === "deleted") {
        for (const account of accounts) {
          await db.update(ConnectorAccountTable).set({ status: "disconnected", updatedAt: new Date() }).where(eq(ConnectorAccountTable.id, account.id))
        }
        return { accepted: true as const, queued: false as const }
      }
    }
    return { accepted: false as const, reason: "event ignored" }
  }

  if (!input.repositoryFullName || !input.ref || !input.headSha || !input.repositoryId) {
    return { accepted: false as const, reason: "missing push metadata" }
  }

  const instances = await db
    .select({ instance: ConnectorInstanceTable, target: ConnectorTargetTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorTargetTable.connectorType, "github"), eq(ConnectorTargetTable.remoteId, input.repositoryFullName)))

  const queuedIds: string[] = []
  for (const row of instances) {
    const targetConfig = row.target.targetConfigJson ?? {}
    const targetRef = typeof targetConfig.ref === "string" ? targetConfig.ref : null
    if (targetRef && targetRef !== input.ref) {
      continue
    }

    const existing = await db
      .select({ id: ConnectorSyncEventTable.id })
      .from(ConnectorSyncEventTable)
      .where(and(
        eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
        eq(ConnectorSyncEventTable.eventType, "push"),
        eq(ConnectorSyncEventTable.sourceRevisionRef, input.headSha),
      ))
      .limit(1)

    let autoImportSummary: {
      autoImported: boolean
      createdPluginCount: number
      materializedConfigObjectCount: number
    }
    try {
      autoImportSummary = await maybeAutoImportGithubConnectorInstance({
        connectorInstance: row.instance,
        connectorTarget: row.target,
      })
    } catch (error) {
      autoImportSummary = {
        autoImported: false,
        createdPluginCount: 0,
        materializedConfigObjectCount: 0,
      }
    }

    const eventStatus = autoImportSummary.autoImported ? "completed" as const : "queued" as const
    const completedAt = autoImportSummary.autoImported ? new Date() : null

    const id = existing[0]?.id ?? createDenTypeId("connectorSyncEvent")
    if (existing[0]) {
      await db.update(ConnectorSyncEventTable).set({
        completedAt,
        externalEventRef: input.deliveryId,
        startedAt: new Date(),
        status: eventStatus,
        summaryJson: {
          autoImportApplied: autoImportSummary.autoImported,
          autoImportCreatedPluginCount: autoImportSummary.createdPluginCount,
          autoImportMaterializedConfigObjectCount: autoImportSummary.materializedConfigObjectCount,
          deliveryId: input.deliveryId,
          headSha: input.headSha,
          repositoryFullName: input.repositoryFullName,
          repositoryId: input.repositoryId,
          queuedAt: new Date().toISOString(),
          ref: input.ref,
        },
      }).where(eq(ConnectorSyncEventTable.id, id))
    } else {
      await db.insert(ConnectorSyncEventTable).values({
        completedAt,
        connectorInstanceId: row.instance.id,
        connectorTargetId: row.target.id,
        connectorType: "github",
        eventType: "push",
        externalEventRef: input.deliveryId,
        id,
        organizationId: row.instance.organizationId,
        remoteId: input.repositoryFullName,
        sourceRevisionRef: input.headSha,
        startedAt: new Date(),
        status: eventStatus,
        summaryJson: {
          autoImportApplied: autoImportSummary.autoImported,
          autoImportCreatedPluginCount: autoImportSummary.createdPluginCount,
          autoImportMaterializedConfigObjectCount: autoImportSummary.materializedConfigObjectCount,
          deliveryId: input.deliveryId,
          headSha: input.headSha,
          installationId: input.installationId,
          repositoryFullName: input.repositoryFullName,
          repositoryId: input.repositoryId,
          ref: input.ref,
        },
      })
    }
    queuedIds.push(id)
  }

  return queuedIds.length > 0
    ? { accepted: true as const, queued: true as const, syncEventIds: queuedIds }
    : { accepted: false as const, reason: "event ignored" }
}
