import type { RuntimeInstanceRecord, RuntimeInstanceStore } from "@openwork-ee/cloud-runtime/orchestrator"
import type { ProviderEndpointKind } from "@openwork-ee/cloud-runtime/contract"
import { eq } from "@openwork-ee/den-db/drizzle"
import { CloudRuntimeInstanceTable, DaytonaSandboxTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

type InstanceRow = typeof CloudRuntimeInstanceTable.$inferSelect

function workerId(value: string) {
  return normalizeDenTypeId("worker", value)
}

export function runtimeInstanceRecordFromRow(row: InstanceRow): RuntimeInstanceRecord {
  return {
    workerId: row.worker_id,
    sandbox: { providerId: row.provider_id, ref: row.provider_ref },
    storage: { workspaceVolumeId: row.workspace_volume_id, dataVolumeId: row.data_volume_id },
    endpointUrl: row.endpoint_url,
    endpointExpiresAt: row.endpoint_expires_at,
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
 * Keep the pre-neutral table in step so a rollback to a Den that still reads
 * `daytona_sandbox` sees the same instance and endpoint. Only Daytona records
 * have a legacy shape; other providers write the neutral table alone.
 */
async function mirrorLegacyDaytonaRow(record: RuntimeInstanceRecord) {
  if (record.sandbox.providerId !== "daytona") return
  const legacy = {
    sandbox_id: sandboxIdOf(record),
    workspace_volume_id: record.storage.workspaceVolumeId,
    data_volume_id: record.storage.dataVolumeId,
    signed_preview_url: record.endpointUrl,
    signed_preview_url_expires_at: record.endpointExpiresAt,
    region: record.region,
  }
  const existing = await db
    .select({ id: DaytonaSandboxTable.id })
    .from(DaytonaSandboxTable)
    .where(eq(DaytonaSandboxTable.worker_id, workerId(record.workerId)))
    .limit(1)
  if (existing.length > 0) {
    await db.update(DaytonaSandboxTable).set(legacy).where(eq(DaytonaSandboxTable.worker_id, workerId(record.workerId)))
    return
  }
  await db.insert(DaytonaSandboxTable).values({
    id: createDenTypeId("daytonaSandbox"),
    worker_id: workerId(record.workerId),
    ...legacy,
  })
}

export function createDatabaseRuntimeInstanceStore(input: { endpointKind: ProviderEndpointKind }): RuntimeInstanceStore {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(CloudRuntimeInstanceTable)
        .where(eq(CloudRuntimeInstanceTable.worker_id, workerId(id)))
        .limit(1)
      const row = rows[0]
      return row ? runtimeInstanceRecordFromRow(row) : null
    },
    async upsert(record) {
      const values = {
        provider_id: record.sandbox.providerId,
        provider_ref: { ...record.sandbox.ref },
        workspace_volume_id: record.storage.workspaceVolumeId,
        data_volume_id: record.storage.dataVolumeId,
        endpoint_url: record.endpointUrl,
        endpoint_expires_at: record.endpointExpiresAt,
        endpoint_kind: input.endpointKind,
        region: record.region,
      }
      const existing = await db
        .select({ id: CloudRuntimeInstanceTable.id })
        .from(CloudRuntimeInstanceTable)
        .where(eq(CloudRuntimeInstanceTable.worker_id, workerId(record.workerId)))
        .limit(1)

      if (existing.length > 0) {
        await db
          .update(CloudRuntimeInstanceTable)
          .set(values)
          .where(eq(CloudRuntimeInstanceTable.worker_id, workerId(record.workerId)))
      } else {
        await db.insert(CloudRuntimeInstanceTable).values({
          id: createDenTypeId("cloudRuntimeInstance"),
          worker_id: workerId(record.workerId),
          ...values,
        })
      }
      await mirrorLegacyDaytonaRow(record)
    },
    async updateEndpoint(id, update) {
      await db
        .update(CloudRuntimeInstanceTable)
        .set({
          endpoint_url: update.endpointUrl,
          endpoint_expires_at: update.endpointExpiresAt,
          region: update.region,
        })
        .where(eq(CloudRuntimeInstanceTable.worker_id, workerId(id)))
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
