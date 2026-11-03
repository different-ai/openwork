import { and, desc, eq, isNotNull, or, sql } from "@openwork-ee/den-db/drizzle"
import { WorkflowRunTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

type WorkflowRun = typeof WorkflowRunTable.$inferSelect
type SnapshotStateRow = {
  receiptId: WorkflowRun["id"]
  pluginId: WorkflowRun["plugin_id"]
  status: WorkflowRun["status"]
  errorMessage: WorkflowRun["error_message"]
  finishedAt: WorkflowRun["finished_at"]
  contentDeletedAt: WorkflowRun["artifact_content_deleted_at"]
  hasMarkdown: number
}
const SNAPSHOT_BATCH_SIZE = 100
const SNAPSHOTS_PER_WORKFLOW = 100

export function snapshotReadAccess(memberId: DenTypeId<"member">) {
  if (!memberId) throw new Error("workflow_receipt_member_required")
  return or(
    eq(WorkflowRunTable.org_membership_id, memberId),
    eq(WorkflowRunTable.source, sql`concat('plugin:', ${WorkflowRunTable.plugin_id}, ':', ${WorkflowRunTable.config_object_id})`),
  )
}

/** The same readable history window as detail, with one metadata query per batch. */
export async function workflowSnapshotStateRows(
  organizationId: DenTypeId<"organization">,
  configObjectIds: DenTypeId<"configObject">[],
  memberId: DenTypeId<"member">,
) {
  const states = new Map<string, SnapshotStateRow[]>()
  const ids = [...new Set(configObjectIds)]
  for (let offset = 0; offset < ids.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
    // Keep an indexed, bounded lookup for each workflow. Ranking a whole batch
    // scans every historical receipt before applying the per-workflow limit.
    const queries = batch.map((configObjectId) => db.select({
      configObjectId: WorkflowRunTable.config_object_id,
      receiptId: WorkflowRunTable.id,
      pluginId: WorkflowRunTable.plugin_id,
      status: WorkflowRunTable.status,
      errorMessage: WorkflowRunTable.error_message,
      finishedAt: WorkflowRunTable.finished_at,
      contentDeletedAt: WorkflowRunTable.artifact_content_deleted_at,
      hasMarkdown: sql<number>`${WorkflowRunTable.result_markdown} is not null`.mapWith(Number).as("has_markdown"),
    }).from(WorkflowRunTable).where(and(
      eq(WorkflowRunTable.organization_id, organizationId),
      snapshotReadAccess(memberId),
      eq(WorkflowRunTable.config_object_id, configObjectId),
      isNotNull(WorkflowRunTable.config_object_version_id),
    )).orderBy(desc(WorkflowRunTable.finished_at), desc(WorkflowRunTable.id)).limit(SNAPSHOTS_PER_WORKFLOW))
    const query = queries[0]
    if (!query) continue
    for (const next of queries.slice(1)) query.unionAll(next)
    const snapshots = query.as("workflow_snapshots")
    const rows = await db.select().from(snapshots)
      .orderBy(desc(snapshots.finishedAt), desc(snapshots.receiptId))
    for (const row of rows) {
      if (!row.configObjectId) continue
      const snapshots = states.get(row.configObjectId) ?? []
      snapshots.push(row)
      states.set(row.configObjectId, snapshots)
    }
  }
  return states
}
