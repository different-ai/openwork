import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
} from "@openwork-ee/den-db/drizzle"
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
  ExternalMcpConnectionAccessGrantTable,
  MarketplaceAccessGrantTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { type PluginArchActorContext, resolvePluginArchResourceRole } from "../../../../routes/org/plugin-system/access.js"
import { planConnectorImportedResourceCleanup, uniqueIds } from "../../../../routes/org/plugin-system/connector-cleanup.js"
import { db } from "../../../../db.js"
import { PluginArchRouteFailure } from "../../store/route-failure.js"
import {
  type ConfigObjectId,
  type ConnectorAccountId,
  type ConnectorAccountRow,
  type ConnectorInstanceId,
  type ConnectorInstanceRow,
  type ConnectorMappingId,
  type ConnectorMappingRow,
  type ConnectorSyncEventId,
  type ConnectorSyncEventRow,
  type ConnectorTargetId,
  type ConnectorTargetRow,
  type DbTransaction,
  ensureEditablePlugin,
  ensureVisibleConnectorInstance,
  type MarketplaceId,
  normalizeOptionalString,
  type OrganizationId,
  pageItems,
  type PluginId,
  type PluginMcpRequirementBindingId,
  serializePlugin,
} from "../../store/internal.js"
import {
  ensureEditableConnectorInstance,
  getConnectorAccountRow,
  getConnectorMappingRow,
  getConnectorSyncEventRow,
  getConnectorTargetRow,
  resolveCreatorName,
  serializeConnectorAccount,
  serializeConnectorInstance,
  serializeConnectorMapping,
  serializeConnectorSyncEvent,
  serializeConnectorTarget,
} from "./shared.js"

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

  // Resolve every imported marketplace/plugin id to delete up front so the
  // transaction below is a single pass of pure writes (no reads on the tx).
  const importedResourceCleanupPlan = await planConnectorImportedResourceCleanupIds({ organizationId, seedPluginIds: connectorPluginIds })
  const pluginMcpRequirementBindingIdsToDelete = await pluginMcpRequirementBindingIdsForHardDeletedResources({
    configObjectIds,
    organizationId,
    pluginIds: importedResourceCleanupPlan.pluginIdsToDelete,
  })
  importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete = uniqueIds([
    ...importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
    ...pluginMcpRequirementBindingIdsToDelete,
  ])

  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({
      bindingIds: importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
      tx,
    })

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

    await deleteConnectorImportedResources({ organizationId, plan: importedResourceCleanupPlan, tx })

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

type ConnectorImportedResourceCleanupPlan = {
  marketplaceIdsToDelete: MarketplaceId[]
  pluginMcpRequirementBindingIdsToDelete: PluginMcpRequirementBindingId[]
  pluginIdsToDelete: PluginId[]
}

async function pluginMcpRequirementBindingIdsForHardDeletedResources(input: {
  configObjectIds: ConfigObjectId[]
  organizationId: OrganizationId
  pluginIds: PluginId[]
}) {
  const bindingIds = new Set<PluginMcpRequirementBindingId>()
  const configObjectIds = uniqueIds(input.configObjectIds)
  const pluginIds = uniqueIds(input.pluginIds)

  if (configObjectIds.length > 0) {
    const rows = await db
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        inArray(PluginMcpRequirementBindingTable.configObjectId, configObjectIds),
      ))
    for (const row of rows) bindingIds.add(row.id)
  }

  if (pluginIds.length > 0) {
    const rows = await db
      .select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        inArray(PluginMcpRequirementBindingTable.pluginId, pluginIds),
      ))
    for (const row of rows) bindingIds.add(row.id)
  }

  return [...bindingIds]
}

async function pluginMcpRequirementBindingIdsForConnectorMapping(input: {
  connectorMappingId: ConnectorMappingId
  organizationId: OrganizationId
}) {
  const memberships = await db
    .select({
      configObjectId: PluginConfigObjectTable.configObjectId,
      pluginId: PluginConfigObjectTable.pluginId,
    })
    .from(PluginConfigObjectTable)
    .where(and(
      eq(PluginConfigObjectTable.organizationId, input.organizationId),
      eq(PluginConfigObjectTable.connectorMappingId, input.connectorMappingId),
    ))
  const configObjectIds = uniqueIds(memberships.map((membership) => membership.configObjectId))
  const pluginIds = uniqueIds(memberships.map((membership) => membership.pluginId))
  if (configObjectIds.length === 0 || pluginIds.length === 0) return []
  const membershipKeys = new Set(memberships.map((membership) => `${membership.pluginId}:${membership.configObjectId}`))
  const rows = await db
    .select({
      configObjectId: PluginMcpRequirementBindingTable.configObjectId,
      id: PluginMcpRequirementBindingTable.id,
      pluginId: PluginMcpRequirementBindingTable.pluginId,
    })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      inArray(PluginMcpRequirementBindingTable.configObjectId, configObjectIds),
      inArray(PluginMcpRequirementBindingTable.pluginId, pluginIds),
    ))
  return rows
    .filter((row) => membershipKeys.has(`${row.pluginId}:${row.configObjectId}`))
    .map((row) => row.id)
}

async function deletePluginMcpRequirementBindingsForHardDelete(input: {
  bindingIds: PluginMcpRequirementBindingId[]
  tx: DbTransaction
}) {
  const bindingIds = uniqueIds(input.bindingIds)
  if (bindingIds.length === 0) return
  await input.tx.delete(ExternalMcpConnectionAccessGrantTable).where(inArray(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingIds))
  await input.tx.delete(PluginMcpRequirementBindingTable).where(inArray(PluginMcpRequirementBindingTable.id, bindingIds))
}

// Read-only planning pass. Runs outside of any transaction so that the
// subsequent delete pass can execute as a single transaction of pure writes.
async function planConnectorImportedResourceCleanupIds(input: { organizationId: OrganizationId; seedPluginIds: PluginId[] }): Promise<ConnectorImportedResourceCleanupPlan> {
  const uniqueSeedPluginIds = uniqueIds(input.seedPluginIds)
  if (uniqueSeedPluginIds.length === 0) {
    return { marketplaceIdsToDelete: [], pluginMcpRequirementBindingIdsToDelete: [], pluginIdsToDelete: [] }
  }

  const connectorMarketplaceRows = await db
    .select({ marketplaceId: MarketplacePluginTable.marketplaceId })
    .from(MarketplacePluginTable)
    .innerJoin(MarketplaceTable, eq(MarketplacePluginTable.marketplaceId, MarketplaceTable.id))
    .where(and(
      inArray(MarketplacePluginTable.pluginId, uniqueSeedPluginIds),
      eq(MarketplacePluginTable.organizationId, input.organizationId),
      eq(MarketplaceTable.organizationId, input.organizationId),
      eq(MarketplacePluginTable.membershipSource, "connector"),
      isNull(MarketplacePluginTable.removedAt),
    ))
  const candidateMarketplaceIds = uniqueIds(connectorMarketplaceRows.map((row) => row.marketplaceId))

  const activeMarketplaceMemberships = candidateMarketplaceIds.length === 0
    ? []
    : await db
      .select({
        marketplaceId: MarketplacePluginTable.marketplaceId,
        membershipSource: MarketplacePluginTable.membershipSource,
        pluginId: MarketplacePluginTable.pluginId,
      })
      .from(MarketplacePluginTable)
      .where(and(
        inArray(MarketplacePluginTable.marketplaceId, candidateMarketplaceIds),
        eq(MarketplacePluginTable.organizationId, input.organizationId),
        isNull(MarketplacePluginTable.removedAt),
      ))

  const candidatePluginIds = uniqueIds([
    ...uniqueSeedPluginIds,
    ...activeMarketplaceMemberships
      .filter((membership) => membership.membershipSource === "connector")
      .map((membership) => membership.pluginId),
  ])

  const activePluginMembershipRows = candidatePluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: PluginConfigObjectTable.pluginId })
      .from(PluginConfigObjectTable)
      .where(and(
        inArray(PluginConfigObjectTable.pluginId, candidatePluginIds),
        eq(PluginConfigObjectTable.organizationId, input.organizationId),
        isNull(PluginConfigObjectTable.removedAt),
      ))

  const activeMappingRows = candidatePluginIds.length === 0
    ? []
    : await db
      .select({ pluginId: ConnectorMappingTable.pluginId })
      .from(ConnectorMappingTable)
      .where(and(
        inArray(ConnectorMappingTable.pluginId, candidatePluginIds),
        eq(ConnectorMappingTable.organizationId, input.organizationId),
      ))

  const plan = planConnectorImportedResourceCleanup({
    activeMarketplaceMemberships,
    activeMappingPluginIds: activeMappingRows
      .map((row) => row.pluginId)
      .filter((pluginId): pluginId is PluginId => Boolean(pluginId)),
    activePluginMembershipPluginIds: activePluginMembershipRows.map((row) => row.pluginId),
    candidateMarketplaceIds,
    candidatePluginIds,
  })

  return {
    ...plan,
    pluginMcpRequirementBindingIdsToDelete: await pluginMcpRequirementBindingIdsForHardDeletedResources({
      configObjectIds: [],
      organizationId: input.organizationId,
      pluginIds: plan.pluginIdsToDelete,
    }),
  }
}

// Write-only delete pass. Must run inside a transaction. Contains no reads so it
// is safe to run alongside the other deletes on the same Vitess connection.
async function deleteConnectorImportedResources(input: {
  organizationId: OrganizationId
  plan: ConnectorImportedResourceCleanupPlan
  tx: DbTransaction
}) {
  const { marketplaceIdsToDelete, pluginIdsToDelete } = input.plan

  if (pluginIdsToDelete.length > 0) {
    await input.tx.delete(PluginConfigObjectTable).where(and(inArray(PluginConfigObjectTable.pluginId, pluginIdsToDelete), eq(PluginConfigObjectTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplacePluginTable).where(and(inArray(MarketplacePluginTable.pluginId, pluginIdsToDelete), eq(MarketplacePluginTable.organizationId, input.organizationId)))
    await input.tx.delete(PluginAccessGrantTable).where(and(inArray(PluginAccessGrantTable.pluginId, pluginIdsToDelete), eq(PluginAccessGrantTable.organizationId, input.organizationId)))
    await input.tx.delete(PluginTable).where(and(inArray(PluginTable.id, pluginIdsToDelete), eq(PluginTable.organizationId, input.organizationId)))
  }

  if (marketplaceIdsToDelete.length > 0) {
    await input.tx.delete(MarketplacePluginTable).where(and(inArray(MarketplacePluginTable.marketplaceId, marketplaceIdsToDelete), eq(MarketplacePluginTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplaceAccessGrantTable).where(and(inArray(MarketplaceAccessGrantTable.marketplaceId, marketplaceIdsToDelete), eq(MarketplaceAccessGrantTable.organizationId, input.organizationId)))
    await input.tx.delete(MarketplaceTable).where(and(inArray(MarketplaceTable.id, marketplaceIdsToDelete), eq(MarketplaceTable.organizationId, input.organizationId)))
  }
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
    configuredPlugins: pluginRows.map((row) => {
      const componentCounts = Object.fromEntries(pluginComponentCounts.get(row.id) ?? new Map())
      return {
        ...serializePlugin(row, membershipCounts.get(row.id) ?? 0, [], componentCounts),
        componentCounts,
        rootPath: pluginRootPaths.get(row.id) ?? null,
      }
    }),
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

  // Resolve every imported marketplace/plugin id to delete up front so the
  // transaction below is a single pass of pure writes (no reads on the tx).
  const importedResourceCleanupPlan = await planConnectorImportedResourceCleanupIds({ organizationId: instance.organizationId, seedPluginIds: pluginIds })
  const pluginMcpRequirementBindingIdsToDelete = await pluginMcpRequirementBindingIdsForHardDeletedResources({
    configObjectIds,
    organizationId: instance.organizationId,
    pluginIds: importedResourceCleanupPlan.pluginIdsToDelete,
  })
  importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete = uniqueIds([
    ...importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
    ...pluginMcpRequirementBindingIdsToDelete,
  ])

  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({
      bindingIds: importedResourceCleanupPlan.pluginMcpRequirementBindingIdsToDelete,
      tx,
    })

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

    await deleteConnectorImportedResources({ organizationId: instance.organizationId, plan: importedResourceCleanupPlan, tx })
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
  const bindingIds = await pluginMcpRequirementBindingIdsForConnectorMapping({
    connectorMappingId: mapping.id,
    organizationId: mapping.organizationId,
  })
  await db.transaction(async (tx) => {
    await deletePluginMcpRequirementBindingsForHardDelete({ bindingIds, tx })
    await tx.delete(PluginConfigObjectTable).where(eq(PluginConfigObjectTable.connectorMappingId, mapping.id))
    await tx.delete(ConnectorMappingTable).where(eq(ConnectorMappingTable.id, mapping.id))
  })
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
  await db.update(ConnectorSyncEventTable).set({
    attemptCount: 0,
    completedAt: null,
    nextAttemptAt: null,
    startedAt: new Date(),
    status: "queued",
  }).where(eq(ConnectorSyncEventTable.id, row.id))
  return { id: row.id }
}

export async function syncConnectorInstanceNow(input: { connectorInstanceId: ConnectorInstanceId; context: PluginArchActorContext }) {
  const instance = await ensureEditableConnectorInstance(input.context, input.connectorInstanceId)
  const targets = await db
    .select()
    .from(ConnectorTargetTable)
    .where(eq(ConnectorTargetTable.connectorInstanceId, instance.id))
    .orderBy(asc(ConnectorTargetTable.createdAt), asc(ConnectorTargetTable.id))

  let enqueuedCount = 0
  for (const target of targets) {
    const activeEvents = await db
      .select({ id: ConnectorSyncEventTable.id })
      .from(ConnectorSyncEventTable)
      .where(and(
        eq(ConnectorSyncEventTable.connectorTargetId, target.id),
        inArray(ConnectorSyncEventTable.status, ["queued", "running"]),
      ))
      .limit(1)
    if (activeEvents[0]) continue

    await db.insert(ConnectorSyncEventTable).values({
      connectorInstanceId: instance.id,
      connectorTargetId: target.id,
      connectorType: target.connectorType,
      eventType: "manual_resync",
      externalEventRef: null,
      id: createDenTypeId("connectorSyncEvent"),
      organizationId: instance.organizationId,
      remoteId: target.remoteId,
      sourceRevisionRef: null,
      startedAt: new Date(),
      status: "queued",
      summaryJson: { trigger: "manual" },
    })
    enqueuedCount += 1
  }

  return { enqueuedCount }
}
