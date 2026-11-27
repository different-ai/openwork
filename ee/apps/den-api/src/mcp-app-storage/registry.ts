import { eq } from "@openwork-ee/den-db/drizzle"
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The artifact's database as Den last saw it, or null when it has never saved anything. */
export async function readMcpAppStorageRecord(ref: StorageDatabaseRef): Promise<McpAppStorageRecord | null> {
  const [row] = await db.select().from(McpAppStorageTable)
    .where(eq(McpAppStorageTable.configObjectId, normalizeDenTypeId("configObject", ref.appId))).limit(1)
  return row && row.organizationId === normalizeDenTypeId("organization", ref.organizationId) ? record(row) : null
}

/** Records that the artifact has a database, with its size and row count after the latest write. */
export async function recordMcpAppStorageUse(ref: StorageDatabaseRef, usage: { backend: McpAppStorageBackendKind; rowCount: number; sizeBytes: number }): Promise<void> {
  const values = { backend: usage.backend, rowCount: usage.rowCount, sizeBytes: usage.sizeBytes }
  await db.insert(McpAppStorageTable).values({
    configObjectId: normalizeDenTypeId("configObject", ref.appId),
    organizationId: normalizeDenTypeId("organization", ref.organizationId),
    ...values,
  }).onDuplicateKeyUpdate({ set: values })
}

export async function listOrganizationMcpAppStorage(organizationId: string): Promise<McpAppStorageRecord[]> {
  const rows = await db.select().from(McpAppStorageTable)
    .where(eq(McpAppStorageTable.organizationId, normalizeDenTypeId("organization", organizationId)))
  return rows.map(record)
}

export async function removeMcpAppStorageRecord(ref: StorageDatabaseRef): Promise<void> {
  await db.delete(McpAppStorageTable).where(eq(McpAppStorageTable.configObjectId, normalizeDenTypeId("configObject", ref.appId)))
}
