import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
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

export class PluginMcpRequirementConnectionMissingError extends Error {
  constructor() {
    super("The external MCP connection no longer exists.")
    this.name = "PluginMcpRequirementConnectionMissingError"
  }
}

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
}): Promise<PluginMcpRequirementBindingRow> {
  const serverName = input.serverName.trim()
  return db.transaction(async (tx) => {
    // This lock is shared with connection deletion and conditional saga
    // cleanup. A delete that wins first makes this write fail; a binding that
    // wins first becomes visible before cleanup decides whether the row is in
    // use. That prevents dangling bindings and cross-import data loss.
    const connection = await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.externalMcpConnectionId),
      ))
      .limit(1)
      .for("update")
    if (!connection[0]) throw new PluginMcpRequirementConnectionMissingError()

    const existing = await tx
      .select()
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, input.organizationId),
        eq(PluginMcpRequirementBindingTable.pluginId, input.pluginId),
        eq(PluginMcpRequirementBindingTable.configObjectId, input.configObjectId),
        eq(PluginMcpRequirementBindingTable.serverName, serverName),
      ))
      .limit(1)
      .for("update")

    const now = new Date()
    if (existing[0]) {
      await tx
        .update(PluginMcpRequirementBindingTable)
        .set({
          externalMcpConnectionId: input.externalMcpConnectionId,
          updatedAt: now,
        })
        .where(eq(PluginMcpRequirementBindingTable.id, existing[0].id))
      return {
        ...existing[0],
        externalMcpConnectionId: input.externalMcpConnectionId,
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
      createdByOrgMembershipId: input.createdByOrgMembershipId,
      createdAt: now,
      updatedAt: now,
    }
    await tx.insert(PluginMcpRequirementBindingTable).values(row)
    return row
  })
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
