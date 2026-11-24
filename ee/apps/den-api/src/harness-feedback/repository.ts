import { and, desc, eq, gte, inArray, isNotNull, isNull, sql, count } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackGroupTable as Groups, HarnessFeedbackReportTable as Reports, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { checkFixedWindowRateLimit } from "../utils/rate-limit.js"

export type HarnessFeedbackIdentity = {
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
  clientKind: typeof Reports.$inferInsert.clientKind
}

type ReportInput = Pick<typeof Reports.$inferInsert, "surface" | "tool" | "errorCode" | "symptom" | "workaround">
export const HARNESS_FEEDBACK_RATE_LIMIT = 10
const HOUR_MS = 60 * 60 * 1000
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000
const PAGE_SIZE = 100

function activeMember(identity: HarnessFeedbackIdentity) {
  return and(eq(MemberTable.organizationId, identity.organizationId), eq(MemberTable.userId, identity.userId),
    isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))
}

export async function findHarnessFeedbackMember(identity: HarnessFeedbackIdentity) {
  const [member] = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(activeMember(identity)).limit(1)
  return member?.id ?? null
}

export async function captureHarnessFeedback(identity: HarnessFeedbackIdentity, input: ReportInput) {
  const memberId = await findHarnessFeedbackMember(identity)
  if (!memberId) return { kind: "forbidden" } satisfies { kind: "forbidden" }
  const now = Date.now()
  const retryAfterSeconds = await checkFixedWindowRateLimit(`harness-feedback:${memberId}`, HARNESS_FEEDBACK_RATE_LIMIT, HOUR_MS, now)
  if (retryAfterSeconds !== null) return { kind: "limited", retryAfterSeconds } satisfies { kind: "limited"; retryAfterSeconds: number }
  return db.transaction(async (tx): Promise<{ kind: "forbidden" | "duplicate" | "stored" }> => {
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(activeMember(identity), eq(MemberTable.id, memberId))).limit(1).for("update")
    if (!member) return { kind: "forbidden" }

    const tool = input.tool ?? null
    const recent = await tx.select({ tool: Reports.tool, symptom: Reports.symptom }).from(Reports).where(and(
      eq(Reports.organizationId, identity.organizationId), eq(Reports.memberId, memberId), eq(Reports.surface, input.surface),
      gte(Reports.createdAt, new Date(now - DUPLICATE_WINDOW_MS)),
    )).for("update")
    if (recent.some((row) => row.tool === tool && row.symptom === input.symptom)) return { kind: "duplicate" }

    await tx.insert(Reports).values({
      id: createDenTypeId("harnessFeedbackReport"), organizationId: identity.organizationId, memberId,
      clientKind: identity.clientKind, surface: input.surface, tool, errorCode: input.errorCode,
      symptom: input.symptom, workaround: input.workaround,
    })
    return { kind: "stored" }
  })
}

const reportMetadata = {
  id: Reports.id, organizationId: Reports.organizationId, state: Reports.state,
  surface: Reports.surface, tool: Reports.tool, errorCode: Reports.errorCode, createdAt: Reports.createdAt,
}

export async function listHarnessFeedback(organizationIds: DenTypeId<"organization">[]) {
  if (organizationIds.length === 0) {
    return { summary: { groups: 0, reports: 0, ungrouped: 0, pending: 0 }, groups: [], ungroupedReports: [] }
  }
  const reportScope = inArray(Reports.organizationId, organizationIds)
  const groupScope = inArray(Groups.organizationId, organizationIds)
  const [groups, ungroupedReports, [groupTotals], [reportTotals]] = await Promise.all([
    db.select({
      id: Groups.id, organizationId: Groups.organizationId, title: Groups.title, category: Groups.category,
      surface: Groups.surface, tool: Groups.tool, reportCount: Groups.reportCount, firstSeenAt: Groups.firstSeenAt,
      lastSeenAt: Groups.lastSeenAt, notifyState: Groups.notifyState,
    }).from(Groups).where(groupScope).orderBy(desc(Groups.lastSeenAt), desc(Groups.id)).limit(PAGE_SIZE),
    db.select(reportMetadata).from(Reports).where(and(reportScope, isNull(Reports.groupId)))
      .orderBy(desc(Reports.createdAt), desc(Reports.id)).limit(PAGE_SIZE),
    db.select({ total: count() }).from(Groups).where(groupScope),
    db.select({
      total: count(), ungrouped: count(sql`case when ${Reports.groupId} is null then 1 end`),
      pending: count(sql`case when ${Reports.state} = 'pending' then 1 end`),
    }).from(Reports).where(reportScope),
  ])
  return {
    summary: { groups: groupTotals?.total ?? 0, reports: reportTotals?.total ?? 0, ungrouped: reportTotals?.ungrouped ?? 0, pending: reportTotals?.pending ?? 0 },
    groups: groups.map((group) => ({ ...group, firstSeenAt: group.firstSeenAt.toISOString(), lastSeenAt: group.lastSeenAt.toISOString() })),
    ungroupedReports: ungroupedReports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })),
  }
}

export async function readHarnessFeedbackGroup(organizationId: DenTypeId<"organization">, groupId: DenTypeId<"harnessFeedbackGroup">) {
  const [group] = await db.select({ id: Groups.id }).from(Groups)
    .where(and(eq(Groups.organizationId, organizationId), eq(Groups.id, groupId))).limit(1)
  if (!group) return null
  const reports = await db.select({ ...reportMetadata, symptom: Reports.symptom, workaround: Reports.workaround })
    .from(Reports).where(and(eq(Reports.organizationId, organizationId), eq(Reports.groupId, groupId)))
    .orderBy(desc(Reports.createdAt), desc(Reports.id)).limit(PAGE_SIZE)
  return { reports: reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })) }
}
