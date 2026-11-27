import type { StorageDatabaseRef } from "./backend.js"
import { getMcpAppStorageBackend } from "./index.js"
import {
  listMcpAppStoragePendingDelete,
  listOrganizationMcpAppStorage,
  markMcpAppStorageDeleted,
  markOrganizationMcpAppStorageDeleted,
  removeMcpAppStorageRecord,
  type McpAppStorageRecord,
} from "./registry.js"

const RETRY_BATCH = 50

async function purge(record: Pick<McpAppStorageRecord, "appId" | "organizationId" | "backend">): Promise<boolean> {
  const ref: StorageDatabaseRef = { organizationId: record.organizationId, appId: record.appId }
  try {
    const backend = getMcpAppStorageBackend()
    if (!backend || backend.kind !== record.backend) throw new Error("Storage backend unavailable")
    await backend.delete(ref)
    await removeMcpAppStorageRecord(ref)
    return true
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId: ref.organizationId, appId: ref.appId })
    return false
  }
}

export async function retryMcpAppStorageDeletes(limit = RETRY_BATCH): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  try {
    for (const record of await listMcpAppStoragePendingDelete(limit)) {
      if (await purge(record)) deleted++
      else failed++
    }
  } catch {
    console.error("mcp_app_storage_delete_failed", {})
    failed++
  }
  return { deleted, failed }
}

export async function deleteMcpAppStorage(ref: StorageDatabaseRef): Promise<void> {
  try {
    await markMcpAppStorageDeleted(ref)
    await retryMcpAppStorageDeletes()
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId: ref.organizationId, appId: ref.appId })
  }
}

export async function deleteOrganizationMcpAppStorage(organizationId: string): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  try {
    await markOrganizationMcpAppStorageDeleted(organizationId)
    for (const record of await listOrganizationMcpAppStorage(organizationId)) {
      if (await purge(record)) deleted++
      else failed++
    }
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId })
    failed++
  }
  return { deleted, failed }
}

export function startMcpAppStorageDeleteRetries(intervalMs = 10 * 60_000): () => void {
  const timer = setInterval(() => { void retryMcpAppStorageDeletes() }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
