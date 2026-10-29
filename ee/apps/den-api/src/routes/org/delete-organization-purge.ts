import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuditEventResourceTable,
  AuditEventTable,
  AuditOperationStepTable,
  AuditOperationTable,
  AuditUsageFactTable,
  CapabilityUsageEventTable,
  CapabilityUsageRollupTable,
  ConnectorSyncEventTable,
  DesktopStartupReportTable,
  FeatureUsageTable,
  GatewayRequestLogTable,
  GatewayUsageAuditTable,
  GatewayUsageChargeTable,
  GatewayUsageEventTable,
  GatewayUsageRollupTable,
  HeadlessSessionIndexTable,
  InferenceUsageLedgerBucketChargeTable,
  InferenceUsageLedgerEntryTable,
  MemberTable,
  ModelsAnalyticsEventTable,
  OrganizationTable,
  ScimSyncEventTable,
  TelemetryEventTable,
  TelemetrySessionDimensionTable,
} from "@openwork-ee/den-db/schema"
import { db } from "../../db.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

/** Rows one purge statement deletes: each statement commits on its own and holds its row locks briefly. */
export const ORGANIZATION_PURGE_BATCH_SIZE = 1000

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

/** Repeats a bounded delete until one deletes fewer rows than the batch size, and returns how many rows went. */
async function deleteInBatches(deleteBatch: (limit: number) => Promise<unknown>, batchSize = ORGANIZATION_PURGE_BATCH_SIZE): Promise<number> {
  let deleted = 0
  for (;;) {
    const rows = affectedRows(await deleteBatch(batchSize))
    deleted += rows
    if (rows < batchSize) return deleted
  }
}

/** Deletes parent rows a page at a time, each page's child rows first. */
async function deleteParentsInBatches<Id>(
  readPage: (limit: number) => Promise<Id[]>,
  deletePage: (ids: Id[]) => Promise<unknown>,
  batchSize = ORGANIZATION_PURGE_BATCH_SIZE,
): Promise<void> {
  for (;;) {
    const ids = await readPage(batchSize)
    if (ids.length > 0) await deletePage(ids)
    if (ids.length < batchSize) return
  }
}

function isMissingTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if (("errno" in error && error.errno === 1146) || ("code" in error && error.code === "ER_NO_SUCH_TABLE")) return true
  return "cause" in error && isMissingTable(error.cause)
}

/** Tables added by later migrations hold nothing before those migrations run. */
async function unlessTableMissing(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }
}

/**
 * Deletes an organization's history (request logs, usage, telemetry and audit rows) in bounded batches before the
 * transaction that deletes the organization. These tables grow with use, and PlanetScale ends any transaction after
 * 20 seconds, so they cannot be deleted inside it. Every statement filters on an indexed column and commits on its
 * own, so a failed deletion keeps what it deleted and a retry deletes the rest. Rows written meanwhile are deleted
 * by the final transaction.
 */
export async function purgeOrganizationHistory(organizationId: OrganizationId): Promise<void> {
  const memberIds = (await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(eq(MemberTable.organizationId, organizationId)))
    .map((member) => member.id)

  if (memberIds.length > 0) {
    // Usage events have no organization index; charges have no organization column.
    const events = and(inArray(GatewayUsageEventTable.memberId, memberIds), eq(GatewayUsageEventTable.organizationId, organizationId))
    await deleteParentsInBatches(
      async (limit) => (await db.select({ id: GatewayUsageEventTable.id }).from(GatewayUsageEventTable).where(events).limit(limit)).map((row) => row.id),
      async (ids) => {
        await db.delete(GatewayUsageChargeTable).where(inArray(GatewayUsageChargeTable.eventId, ids))
        await db.delete(GatewayUsageEventTable).where(inArray(GatewayUsageEventTable.id, ids))
      },
    )
  }
  await deleteParentsInBatches(
    async (limit) => (await db
      .select({ id: InferenceUsageLedgerEntryTable.id })
      .from(InferenceUsageLedgerEntryTable)
      .where(eq(InferenceUsageLedgerEntryTable.organization_id, organizationId))
      .limit(limit))
      .map((row) => row.id),
    async (ids) => {
      await db.delete(InferenceUsageLedgerBucketChargeTable).where(inArray(InferenceUsageLedgerBucketChargeTable.ledger_entry_id, ids))
      await db.delete(InferenceUsageLedgerEntryTable).where(inArray(InferenceUsageLedgerEntryTable.id, ids))
    },
  )

  await deleteInBatches((limit) => db.delete(GatewayUsageAuditTable).where(eq(GatewayUsageAuditTable.organizationId, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(GatewayRequestLogTable).where(eq(GatewayRequestLogTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(GatewayUsageRollupTable).where(eq(GatewayUsageRollupTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(AuditOperationTable).where(eq(AuditOperationTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(TelemetryEventTable).where(eq(TelemetryEventTable.org_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(TelemetrySessionDimensionTable).where(eq(TelemetrySessionDimensionTable.org_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(CapabilityUsageEventTable).where(eq(CapabilityUsageEventTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(CapabilityUsageRollupTable).where(eq(CapabilityUsageRollupTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(FeatureUsageTable).where(eq(FeatureUsageTable.organization_id, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(ConnectorSyncEventTable).where(eq(ConnectorSyncEventTable.organizationId, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.organizationId, organizationId)).limit(limit))
  await deleteInBatches((limit) => db.delete(DesktopStartupReportTable).where(eq(DesktopStartupReportTable.organizationId, organizationId)).limit(limit))
  await unlessTableMissing(() => deleteInBatches((limit) => db.delete(ModelsAnalyticsEventTable).where(eq(ModelsAnalyticsEventTable.org_id, organizationId)).limit(limit)))
  await unlessTableMissing(() => deleteInBatches((limit) => db.delete(HeadlessSessionIndexTable).where(eq(HeadlessSessionIndexTable.organizationId, organizationId)).limit(limit)))
}
