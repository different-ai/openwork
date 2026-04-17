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
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext, PluginArchResourceKind, PluginArchRole } from "./access.js"
import { requirePluginArchResourceRole, resolvePluginArchResourceRole } from "./access.js"
import { db } from "../../../db.js"

type OrganizationId = PluginArchActorContext["organizationContext"]["organization"]["id"]
type MemberId = PluginArchActorContext["organizationContext"]["currentMember"]["id"]
type TeamId = PluginArchActorContext["memberTeams"][number]["id"]
type ConfigObjectRow = typeof ConfigObjectTable.$inferSelect
type ConfigObjectVersionRow = typeof ConfigObjectVersionTable.$inferSelect
type PluginRow = typeof PluginTable.$inferSelect
type PluginMembershipRow = typeof PluginConfigObjectTable.$inferSelect
type ConfigObjectId = ConfigObjectRow["id"]
type ConfigObjectVersionId = ConfigObjectVersionRow["id"]
type PluginId = PluginRow["id"]
type PluginMembershipId = PluginMembershipRow["id"]
type AccessGrantRow =
  | typeof ConfigObjectAccessGrantTable.$inferSelect
  | typeof PluginAccessGrantTable.$inferSelect
  | typeof ConnectorInstanceAccessGrantTable.$inferSelect
type ConfigObjectAccessGrantId = typeof ConfigObjectAccessGrantTable.$inferSelect.id
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

type CursorPage<TItem extends { id: string }> = {
  items: TItem[]
  nextCursor: string | null
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
  id: number
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

type ConnectorInstanceResourceTarget = {
  resourceId: ConnectorInstanceId
  resourceKind: "connector_instance"
}

type ResourceTarget =
  | ConfigObjectResourceTarget
  | PluginResourceTarget
  | ConnectorInstanceResourceTarget

type ConfigObjectGrantTarget = ConfigObjectResourceTarget & { grantId: ConfigObjectAccessGrantId }
type PluginGrantTarget = PluginResourceTarget & { grantId: PluginAccessGrantId }
type ConnectorInstanceGrantTarget = ConnectorInstanceResourceTarget & { grantId: ConnectorInstanceAccessGrantId }
type GrantTarget = ConfigObjectGrantTarget | PluginGrantTarget | ConnectorInstanceGrantTarget

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

function serializePlugin(row: PluginRow, memberCount?: number) {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    description: row.description,
    id: row.id,
    memberCount,
    name: row.name,
    organizationId: row.organizationId,
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

function serializeConnectorAccount(row: ConnectorAccountRow) {
  return {
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
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

  const visible: ReturnType<typeof serializePlugin>[] = []
  for (const row of rows) {
    const role = await resolvePluginArchResourceRole({ context: input.context, resourceId: row.id, resourceKind: "plugin" })
    if (!role) continue
    if (input.status && row.status !== input.status) continue
    if (input.q) {
      const haystack = `${row.name}\n${row.description ?? ""}`.toLowerCase()
      if (!haystack.includes(input.q.toLowerCase())) continue
    }
    visible.push(serializePlugin(row, counts.get(row.id) ?? 0))
  }

  return pageItems(visible, input.cursor, input.limit)
}

export async function getPluginDetail(context: PluginArchActorContext, pluginId: PluginId) {
  const row = await ensureVisiblePlugin(context, pluginId)
  const memberships = await db.select({ id: PluginConfigObjectTable.id }).from(PluginConfigObjectTable).where(and(eq(PluginConfigObjectTable.pluginId, row.id), isNull(PluginConfigObjectTable.removedAt)))
  return serializePlugin(row, memberships.length)
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
    .map((row) => serializeConnectorAccount(row))

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
  return serializeConnectorAccount(row)
}

export async function disconnectConnectorAccount(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; reason?: string }) {
  const row = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  const metadata = row.metadataJson ?? {}
  await db.update(ConnectorAccountTable).set({
    metadataJson: input.reason ? { ...metadata, disconnectReason: input.reason } : metadata,
    status: "disconnected",
    updatedAt: new Date(),
  }).where(eq(ConnectorAccountTable.id, row.id))
  return getConnectorAccountDetail(input.context, row.id)
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

function normalizeRepositories(value: unknown): RepositorySummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const candidate = entry as Record<string, unknown>
    const id = typeof candidate.id === "number" ? candidate.id : Number(candidate.id)
    const fullName = typeof candidate.fullName === "string"
      ? candidate.fullName
      : typeof candidate.repositoryFullName === "string"
        ? candidate.repositoryFullName
        : null
    if (!Number.isFinite(id) || !fullName) return []
    return [{
      defaultBranch: typeof candidate.defaultBranch === "string" ? candidate.defaultBranch : null,
      fullName,
      id,
      private: Boolean(candidate.private),
    }]
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
    },
    remoteId: String(input.installationId),
  })
}

export async function listGithubRepositories(input: { connectorAccountId: ConnectorAccountId; context: PluginArchActorContext; cursor?: string; limit?: number; q?: string }) {
  const account = await getConnectorAccountRow(input.context.organizationContext.organization.id, input.connectorAccountId)
  if (!account) {
    throw new PluginArchRouteFailure(404, "connector_account_not_found", "Connector account not found.")
  }
  const repositories = normalizeRepositories(account.metadataJson && typeof account.metadataJson === "object" ? (account.metadataJson as Record<string, unknown>).repositories : [])
    .filter((repository) => !input.q || `${repository.fullName}\n${repository.defaultBranch ?? ""}`.toLowerCase().includes(input.q.toLowerCase()))
    .map((repository) => ({ ...repository, id: String(repository.id) }))
  const page = pageItems(repositories, input.cursor, input.limit)
  return {
    items: page.items.map((repository) => ({ defaultBranch: repository.defaultBranch, fullName: repository.fullName, id: Number(repository.id), private: repository.private })),
    nextCursor: page.nextCursor,
  }
}

export async function validateGithubTarget(input: { branch: string; ref: string; repositoryFullName: string }) {
  const branch = input.branch.trim()
  const ref = input.ref.trim()
  const expectedRef = `refs/heads/${branch}`
  return {
    branchExists: ref === expectedRef,
    defaultBranch: branch,
    repositoryAccessible: Boolean(input.repositoryFullName.trim()),
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
      installationId: input.installationId,
    },
    context: input.context,
    name: input.connectorInstanceName,
    remoteId: input.repositoryFullName,
  })

  const connectorTarget = await createConnectorTarget({
    config: {
      branch: input.branch,
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

    const id = existing[0]?.id ?? createDenTypeId("connectorSyncEvent")
    if (existing[0]) {
      await db.update(ConnectorSyncEventTable).set({
        completedAt: null,
        externalEventRef: input.deliveryId,
        startedAt: new Date(),
        status: "queued",
        summaryJson: {
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
        completedAt: null,
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
        status: "queued",
        summaryJson: {
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
