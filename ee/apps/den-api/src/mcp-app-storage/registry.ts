import { and, eq, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { McpAppStorageTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import type { McpAppStorageBackendKind, StorageDatabaseRef } from "./backend.js"

export type McpAppStorageRecord = {
  appId: string
  organizationId: string
  backend: string
  rowCount: number
  sizeBytes: number
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function record(row: typeof McpAppStorageTable.$inferSelect): McpAppStorageRecord {
  return {
    appId: row.configObjectId,
    organizationId: row.organizationId,
    backend: row.backend,
    rowCount: row.rowCount,
    sizeBytes: row.sizeBytes,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function appId(ref: StorageDatabaseRef) {
  return normalizeDenTypeId("configObject", ref.appId)
}

export async function readMcpAppStorageRecord(ref: StorageDatabaseRef): Promise<McpAppStorageRecord | null> {
  const [row] = await db.select().from(McpAppStorageTable).where(eq(McpAppStorageTable.configObjectId, appId(ref))).limit(1)
  return row && row.organizationId === normalizeDenTypeId("organization", ref.organizationId) ? record(row) : null
}

export async function claimMcpAppStorage(ref: StorageDatabaseRef, backend: McpAppStorageBackendKind): Promise<McpAppStorageRecord> {
  await db.insert(McpAppStorageTable).values({
    configObjectId: appId(ref),
    organizationId: normalizeDenTypeId("organization", ref.organizationId),
    backend,
  }).onDuplicateKeyUpdate({ set: { configObjectId: sql`config_object_id` } })
  const claimed = await readMcpAppStorageRecord(ref)
  if (!claimed) throw new Error("The artifact storage record belongs to another organization.")
  return claimed
}

export async function recordMcpAppStorageUsage(ref: StorageDatabaseRef, usage: { rowCount: number; sizeBytes: number }): Promise<void> {
  await db.update(McpAppStorageTable).set(usage)
    .where(and(eq(McpAppStorageTable.configObjectId, appId(ref)), isNull(McpAppStorageTable.deletedAt)))
}

export async function markMcpAppStorageDeleted(ref: StorageDatabaseRef): Promise<void> {
  await db.update(McpAppStorageTable).set({ deletedAt: new Date() })
    .where(and(eq(McpAppStorageTable.configObjectId, appId(ref)), isNull(McpAppStorageTable.deletedAt)))
}

export async function markOrganizationMcpAppStorageDeleted(organizationId: string): Promise<void> {
  await db.update(McpAppStorageTable).set({ deletedAt: new Date() })
    .where(and(eq(McpAppStorageTable.organizationId, normalizeDenTypeId("organization", organizationId)), isNull(McpAppStorageTable.deletedAt)))
}

export async function listOrganizationMcpAppStorage(organizationId: string): Promise<McpAppStorageRecord[]> {
  const rows = await db.select().from(McpAppStorageTable)
    .where(eq(McpAppStorageTable.organizationId, normalizeDenTypeId("organization", organizationId)))
  return rows.map(record)
}

export async function listMcpAppStoragePendingDelete(limit: number): Promise<McpAppStorageRecord[]> {
  const rows = await db.select().from(McpAppStorageTable).where(isNotNull(McpAppStorageTable.deletedAt)).limit(limit)
  return rows.map(record)
}

export async function removeMcpAppStorageRecord(ref: StorageDatabaseRef): Promise<void> {
  await db.delete(McpAppStorageTable)
    .where(and(eq(McpAppStorageTable.configObjectId, appId(ref)), isNotNull(McpAppStorageTable.deletedAt)))
}
