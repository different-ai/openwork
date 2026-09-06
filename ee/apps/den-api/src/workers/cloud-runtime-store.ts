import type { RuntimeInstanceRecord, RuntimeInstanceStore } from "@openwork-ee/cloud-runtime/orchestrator"
import { eq } from "@openwork-ee/den-db/drizzle"
import { DaytonaSandboxTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

type InstanceRow = typeof DaytonaSandboxTable.$inferSelect

function workerId(value: string) {
  return normalizeDenTypeId("worker", value)
}

export function runtimeInstanceRecordFromRow(row: InstanceRow, providerId: string): RuntimeInstanceRecord {
  return {
    workerId: row.worker_id,
    sandbox: { providerId, ref: { sandboxId: row.sandbox_id } },
    storage: { workspaceVolumeId: row.workspace_volume_id, dataVolumeId: row.data_volume_id },
    endpointUrl: row.signed_preview_url,
    endpointExpiresAt: row.signed_preview_url_expires_at,
    region: row.region,
  }
}

function sandboxIdOf(record: RuntimeInstanceRecord) {
  const sandboxId = record.sandbox.ref.sandboxId
  if (!sandboxId) {
    throw new Error(`runtime instance record for ${record.workerId} has no sandboxId`)
  }
  return sandboxId
}

/**
 * Den's durable instance records. The table still carries its original name
 * until the neutral store migration lands; the record shape is already
 * provider-neutral.
 */
export function createDatabaseRuntimeInstanceStore(input: { providerId: string }): RuntimeInstanceStore {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(DaytonaSandboxTable)
        .where(eq(DaytonaSandboxTable.worker_id, workerId(id)))
        .limit(1)
      const row = rows[0]
      return row ? runtimeInstanceRecordFromRow(row, input.providerId) : null
    },
    async upsert(record) {
      const existing = await db
        .select({ id: DaytonaSandboxTable.id })
        .from(DaytonaSandboxTable)
        .where(eq(DaytonaSandboxTable.worker_id, workerId(record.workerId)))
        .limit(1)

      if (existing.length > 0) {
        await db
          .update(DaytonaSandboxTable)
          .set({
            sandbox_id: sandboxIdOf(record),
            workspace_volume_id: record.storage.workspaceVolumeId,
            data_volume_id: record.storage.dataVolumeId,
            signed_preview_url: record.endpointUrl,
            signed_preview_url_expires_at: record.endpointExpiresAt,
            region: record.region,
          })
          .where(eq(DaytonaSandboxTable.worker_id, workerId(record.workerId)))
        return
      }

      await db.insert(DaytonaSandboxTable).values({
        id: createDenTypeId("daytonaSandbox"),
        worker_id: workerId(record.workerId),
        sandbox_id: sandboxIdOf(record),
        workspace_volume_id: record.storage.workspaceVolumeId,
        data_volume_id: record.storage.dataVolumeId,
        signed_preview_url: record.endpointUrl,
        signed_preview_url_expires_at: record.endpointExpiresAt,
        region: record.region,
      })
    },
    async updateEndpoint(id, update) {
      await db
        .update(DaytonaSandboxTable)
        .set({
          signed_preview_url: update.endpointUrl,
          signed_preview_url_expires_at: update.endpointExpiresAt,
          region: update.region,
        })
        .where(eq(DaytonaSandboxTable.worker_id, workerId(id)))
    },
    async getWorkerImageVersion(id) {
      const rows = await db
        .select({ image_version: WorkerTable.image_version })
        .from(WorkerTable)
        .where(eq(WorkerTable.id, workerId(id)))
        .limit(1)
      return rows[0]?.image_version ?? null
    },
  }
}
