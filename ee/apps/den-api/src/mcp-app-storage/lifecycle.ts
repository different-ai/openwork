import type { StorageDatabaseRef } from "./backend.js"
import { getMcpAppStorageBackend } from "./index.js"
import { listOrganizationMcpAppStorage, readMcpAppStorageRecord, removeMcpAppStorageRecord } from "./registry.js"

async function deleteRegisteredStorage(ref: StorageDatabaseRef, kind: string): Promise<boolean> {
  try {
    const backend = getMcpAppStorageBackend()
    if (!backend || backend.kind !== kind) throw new Error("Storage backend unavailable")
    await backend.delete(ref)
    await removeMcpAppStorageRecord(ref)
    return true
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId: ref.organizationId, appId: ref.appId })
    return false
  }
}

export async function deleteMcpAppStorage(ref: StorageDatabaseRef): Promise<void> {
  try {
    const record = await readMcpAppStorageRecord(ref)
    if (record) await deleteRegisteredStorage(ref, record.backend)
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId: ref.organizationId, appId: ref.appId })
  }
}

export async function deleteOrganizationMcpAppStorage(organizationId: string): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  try {
    for (const record of await listOrganizationMcpAppStorage(organizationId)) {
      if (await deleteRegisteredStorage(record, record.backend)) deleted++
      else failed++
    }
  } catch {
    console.error("mcp_app_storage_delete_failed", { organizationId })
    failed++
  }
  return { deleted, failed }
}
