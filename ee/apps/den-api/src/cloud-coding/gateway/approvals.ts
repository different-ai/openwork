import { and, desc, eq, gt, inArray, lte } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPullRequestTable as PullRequests, CloudCodingPushApprovalTable as Approvals, CloudCodingTaskTable as Tasks } from "@openwork-ee/den-db/schema"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_SUMMARY_FILES_MAX, cloudCodingPushApprovalSchema, type CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding"
import { db } from "../../db.js"
import { didUpdate } from "./database.js"

export type CloudCodingApprovalRow = typeof Approvals.$inferSelect
export type CloudCodingApprovalScope = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; taskId?: DenTypeId<"cloudCodingTask"> }

function scopeCondition(scope: CloudCodingApprovalScope) {
  return and(eq(Approvals.organizationId, scope.organizationId), eq(Approvals.orgMembershipId, scope.memberId), scope.taskId ? eq(Approvals.taskId, scope.taskId) : undefined)
}

export async function expireCloudCodingApprovals(scope: CloudCodingApprovalScope, database: Pick<AuditTx, "update"> = db, id?: DenTypeId<"cloudCodingPushApproval">) {
  await database.update(Approvals).set({ status: "expired" }).where(and(scopeCondition(scope), id ? eq(Approvals.id, id) : undefined,
    inArray(Approvals.status, ["pending", "approved"]), lte(Approvals.expiresAt, new Date())))
}

export async function getCloudCodingApproval(scope: CloudCodingApprovalScope, approvalId: string): Promise<CloudCodingApprovalRow | null> {
  if (!isDenTypeId("cloudCodingPushApproval", approvalId)) return null
  const condition = and(scopeCondition(scope), eq(Approvals.id, approvalId))
  const [row] = await db.$primary.select().from(Approvals).where(condition).limit(1)
  if (!row) return null
  if ((row.status === "pending" || row.status === "approved") && row.expiresAt.getTime() <= Date.now()) {
    await expireCloudCodingApprovals(scope, db, approvalId)
    const [current] = await db.$primary.select().from(Approvals).where(condition).limit(1)
    return current ?? null
  }
  return row
}

export async function getCloudCodingPullRequest(approvalId: DenTypeId<"cloudCodingPushApproval">, database: Pick<AuditTx, "select"> = db.$primary) {
  const [row] = await database.select().from(PullRequests).where(eq(PullRequests.approvalId, approvalId)).limit(1)
  return row ?? null
}

export async function cloudCodingApprovalView(row: CloudCodingApprovalRow) {
  const pr = await getCloudCodingPullRequest(row.id)
  return cloudCodingPushApprovalSchema.parse({
    id: row.id, taskId: row.taskId, status: row.status, repositoryFullName: row.repositoryFullName, branch: row.branch, baseBranch: row.baseBranch,
    headSha: row.headSha, title: row.title, files: row.summary.files.slice(0, CLOUD_CODING_SUMMARY_FILES_MAX), fileCount: row.summary.fileCount,
    tests: row.summary.tests, requestedAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
  })
}

export async function listCloudCodingApprovals(scope: CloudCodingApprovalScope, status?: "pending") {
  await expireCloudCodingApprovals(scope)
  const query = db.$primary.select().from(Approvals).where(and(scopeCondition(scope), status ? eq(Approvals.status, status) : undefined))
    .orderBy(desc(Approvals.createdAt), desc(Approvals.id))
  const rows = status ? await query : await query.limit(20)
  return Promise.all(rows.map(cloudCodingApprovalView))
}

export async function decideCloudCodingApproval(scope: CloudCodingApprovalScope, approvalId: string, decision: CloudCodingPushDecisionInput["decision"], audit: (tx: AuditTx, row: CloudCodingApprovalRow) => Promise<unknown>) {
  if (!isDenTypeId("cloudCodingPushApproval", approvalId)) return null
  return db.transaction(async tx => {
    const condition = and(scopeCondition(scope), eq(Approvals.id, approvalId))
    const [row] = await tx.select().from(Approvals).where(condition).limit(1).for("update")
    if (!row) return null
    const decidedAt = new Date()
    if (row.status !== "pending" || row.expiresAt <= decidedAt) {
      if (row.expiresAt <= decidedAt) await expireCloudCodingApprovals(scope, tx, approvalId)
      return "not_pending"
    }
    const status = decision === "allow_once" ? "approved" : "denied"
    const updated = await tx.update(Approvals).set({ status, decidedAt }).where(and(condition, eq(Approvals.status, "pending"), gt(Approvals.expiresAt, decidedAt)))
    if (!didUpdate(updated)) return "not_pending"
    if (status === "denied") {
      await tx.update(Tasks).set({ status: "cancelled", failureCode: "push_denied" })
        .where(and(eq(Tasks.id, row.taskId), inArray(Tasks.status, ["created", "running", "awaiting_approval"])))
    }
    const result = { ...row, status, decidedAt } as const
    await audit(tx, result)
    return result
  })
}
