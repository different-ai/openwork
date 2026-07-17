import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpConnectionAccessGrantTable,
  type ExternalMcpAuthType,
  PluginMcpRequirementBindingTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

type OrganizationId = DenTypeId<"organization">
type PluginId = DenTypeId<"plugin">
type ConfigObjectId = DenTypeId<"configObject">
type MemberId = DenTypeId<"member">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">

export type PluginMcpRequirementBindingRow = typeof PluginMcpRequirementBindingTable.$inferSelect

export async function listPluginMcpRequirementBindings(input: {
  configObjectIds: ConfigObjectId[]
  organizationId: OrganizationId
}): Promise<PluginMcpRequirementBindingRow[]> {
  if (input.configObjectIds.length === 0) return []
  return db
    .select()
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      inArray(PluginMcpRequirementBindingTable.configObjectId, input.configObjectIds),
    ))
}

export async function upsertPluginMcpRequirementBinding(input: {
  configObjectId: ConfigObjectId
  createdByOrgMembershipId: MemberId
  externalMcpConnectionId: ExternalMcpConnectionId
  organizationId: OrganizationId
  pluginId: PluginId
  serverName: string
  requiredAuthType: ExternalMcpAuthType | null
  connectionOwnedByPlugin: boolean
}): Promise<PluginMcpRequirementBindingRow> {
  const serverName = input.serverName.trim()
  const existing = await db
    .select()
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
      eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
      eq(PluginMcpRequirementBindingTable.serverName, serverName),
    ))
    .limit(1)

  const now = new Date()
  if (existing[0]) {
    await db
      .update(PluginMcpRequirementBindingTable)
      .set({
        externalMcpConnectionId: input.externalMcpConnectionId,
        requiredAuthType: input.requiredAuthType,
        connectionOwnedByPlugin: input.connectionOwnedByPlugin,
        updatedAt: now,
      })
      .where(eq(PluginMcpRequirementBindingTable.id, existing[0].id))
    return {
      ...existing[0],
      externalMcpConnectionId: input.externalMcpConnectionId,
      requiredAuthType: input.requiredAuthType,
      connectionOwnedByPlugin: input.connectionOwnedByPlugin,
      updatedAt: now,
    }
  }

  const row = {
    id: createDenTypeId("pluginMcpRequirementBinding"),
    organizationId: input.organizationId,
    pluginId: input.pluginId,
    configObjectId: input.configObjectId,
    serverName,
    externalMcpConnectionId: input.externalMcpConnectionId,
    requiredAuthType: input.requiredAuthType,
    connectionOwnedByPlugin: input.connectionOwnedByPlugin,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(PluginMcpRequirementBindingTable).values(row)
  return row
}

export async function deletePluginMcpRequirementBindingsByIds(input: {
  bindingIds: DenTypeId<"pluginMcpRequirementBinding">[]
}): Promise<void> {
  if (input.bindingIds.length === 0) return
  await db
    .delete(ExternalMcpConnectionAccessGrantTable)
    .where(inArray(ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, input.bindingIds))
  await db
    .delete(PluginMcpRequirementBindingTable)
    .where(inArray(PluginMcpRequirementBindingTable.id, input.bindingIds))
}

export async function deletePluginMcpRequirementBindingsForConfigObject(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
}): Promise<void> {
  const rows = await db
    .select({ id: PluginMcpRequirementBindingTable.id })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
    ))
  await deletePluginMcpRequirementBindingsByIds({ bindingIds: rows.map((row) => row.id) })
}

export async function deletePluginMcpRequirementBindingsForPlugin(input: {
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<void> {
  const rows = await db
    .select({ id: PluginMcpRequirementBindingTable.id })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
    ))
  await deletePluginMcpRequirementBindingsByIds({ bindingIds: rows.map((row) => row.id) })
}

export async function deletePluginMcpRequirementBindingsForPluginConfigObject(input: {
  configObjectId: ConfigObjectId
  organizationId: OrganizationId
  pluginId: PluginId
}): Promise<void> {
  const rows = await db
    .select({ id: PluginMcpRequirementBindingTable.id })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
      eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
    ))
  await deletePluginMcpRequirementBindingsByIds({ bindingIds: rows.map((row) => row.id) })
}

export async function activePluginMcpRequirementBindingsReferenceConnection(input: {
  connectionId: ExternalMcpConnectionId
  excludingPluginId: PluginId
  organizationId: OrganizationId
}): Promise<boolean> {
  const rows = await db
    .select({ pluginId: PluginMcpRequirementBindingTable.pluginId })
    .from(PluginMcpRequirementBindingTable)
    .where(and(
      eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
      eq(PluginMcpRequirementBindingTable.externalMcpConnectionId, input.connectionId),
    ))
  return rows.some((row) => row.pluginId !== input.excludingPluginId)
}
