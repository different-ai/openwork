import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql, count } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackGroupTable as Groups, HarnessFeedbackReportTable as Reports, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { checkFixedWindowRateLimit } from "../utils/rate-limit.js"
import { harnessFeedbackOrganizationIds, isHarnessFeedbackOrganization } from "./access.js"
import { harnessFeedbackCategoryLabel, type classifyHarnessFeedback } from "./classifier.js"
import { harnessFeedbackGroupKey } from "./grouping.js"

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
      gte(Reports.createdAt, sessionTimestampFromEpochMs(now - DUPLICATE_WINDOW_MS)),
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

const LEASE_MS = 60_000
export type ClaimedHarnessFeedback = typeof Reports.$inferSelect & { leaseOwner: string }

export async function claimDueHarnessFeedback(limit: number, now: Date): Promise<ClaimedHarnessFeedback[]> {
  const organizationIds = harnessFeedbackOrganizationIds()
  if (!organizationIds.length || limit <= 0) return []
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(Reports).where(and(
      inArray(Reports.organizationId, organizationIds), eq(Reports.state, "pending"), lte(Reports.nextAttemptAt, now),
      or(isNull(Reports.leaseExpiresAt), lte(Reports.leaseExpiresAt, now)),
    )).orderBy(asc(Reports.nextAttemptAt), asc(Reports.id)).limit(limit).for("update", { skipLocked: true })
    if (!rows.length) return []
    const leaseOwner = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS)
    await tx.update(Reports).set({ leaseOwner, leaseExpiresAt }).where(inArray(Reports.id, rows.map((row) => row.id)))
    return rows.map((row) => ({ ...row, leaseOwner, leaseExpiresAt }))
  })
}

type Settlement = Awaited<ReturnType<typeof classifyHarnessFeedback>> | {
  state: "pending" | "needs_review"; attempts: number; nextAttemptAt: Date
}

export async function settleHarnessFeedback(report: ClaimedHarnessFeedback, settlement: Settlement, now: Date) {
  if (!isHarnessFeedbackOrganization(report.organizationId)) return false
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: Reports.id }).from(Reports).where(and(
      eq(Reports.id, report.id), eq(Reports.organizationId, report.organizationId), eq(Reports.state, "pending"),
      eq(Reports.leaseOwner, report.leaseOwner), gt(Reports.leaseExpiresAt, now),
    )).for("update")
    if (!row) return false

    let groupId: DenTypeId<"harnessFeedbackGroup"> | null = null
    let category: string | null = null
    if (settlement.state === "classified") {
      category = settlement.category
      const { fingerprint, title, tool } = harnessFeedbackGroupKey({ ...report, category: settlement.category })
      const groupScope = and(eq(Groups.organizationId, report.organizationId), eq(Groups.fingerprint, fingerprint))
      await tx.insert(Groups).values({
        id: createDenTypeId("harnessFeedbackGroup"), organizationId: report.organizationId, fingerprint,
        title, category, surface: report.surface, tool, reportCount: 1, firstSeenAt: now, lastSeenAt: now,
      }).onDuplicateKeyUpdate({ set: {
        reportCount: sql`${Groups.reportCount} + 1`,
        lastSeenAt: sql`greatest(${Groups.lastSeenAt}, ${sql.param(now, Groups.lastSeenAt)})`,
      } })
      const [group] = await tx.select({ id: Groups.id }).from(Groups).where(groupScope).for("update")
      if (!group) throw new Error("Harness feedback group missing after upsert")
      groupId = group.id
    }

    await tx.update(Reports).set({
      state: settlement.state, groupId, category, leaseOwner: null, leaseExpiresAt: null,
      ...("judgmentDetail" in settlement
        ? { judgmentDetail: settlement.judgmentDetail }
        : { attempts: settlement.attempts, nextAttemptAt: settlement.nextAttemptAt }),
    }).where(eq(Reports.id, row.id))
    return true
  })
}

const MAX_NOTIFY_BATCH = 4
const NOTIFY_LEASE_MS = 60_000
const groupNotificationFields = {
  id: Groups.id, organizationId: Groups.organizationId, title: Groups.title, category: Groups.category,
  surface: Groups.surface, tool: Groups.tool, notifyAttempts: Groups.notifyAttempts, notifyLeaseOwner: Groups.notifyLeaseOwner,
}

function sessionTimestampFromEpochMs(epochMs: number) {
  return sql`from_unixtime(${epochMs / 1000})`
}

export async function claimDueHarnessFeedbackGroups(limit: number, now: Date) {
  const organizationIds = harnessFeedbackOrganizationIds()
  if (!organizationIds.length || !Number.isSafeInteger(limit) || limit <= 0) return []
  return db.transaction(async (tx) => {
    const rows = await tx.select(groupNotificationFields).from(Groups).where(and(
      inArray(Groups.organizationId, organizationIds), eq(Groups.notifyState, "pending"),
      or(isNull(Groups.notifyLeaseExpiresAt), lte(Groups.notifyLeaseExpiresAt, sessionTimestampFromEpochMs(now.getTime()))),
    )).orderBy(asc(Groups.notifyLeaseExpiresAt), asc(Groups.id)).limit(Math.min(limit, MAX_NOTIFY_BATCH)).for("update", { skipLocked: true })
    if (!rows.length) return []
    const notifyLeaseOwner = randomUUID()
    const expiresAt = now.getTime() + NOTIFY_LEASE_MS
    await tx.update(Groups).set({ notifyLeaseOwner, notifyLeaseExpiresAt: sessionTimestampFromEpochMs(expiresAt) })
      .where(inArray(Groups.id, rows.map((row) => row.id)))
    return rows.map((row) => ({ ...row, expiredInFlight: row.notifyLeaseOwner !== null, notifyLeaseOwner, expiresAt }))
  })
}

export type ClaimedHarnessFeedbackGroup = Awaited<ReturnType<typeof claimDueHarnessFeedbackGroups>>[number]
type NotifySettlement = { state: "failed" | "delivered" } | { state: "pending"; retryAt: number }

function updatedGroups(result: unknown): boolean {
  if (Array.isArray(result)) return updatedGroups(result[0])
  if (!result || typeof result !== "object") return false
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected > 0
  return "affectedRows" in result && typeof result.affectedRows === "number" && result.affectedRows > 0
}

export async function settleHarnessFeedbackGroup(group: ClaimedHarnessFeedbackGroup, settlement: NotifySettlement, now: Date) {
  const result = await db.update(Groups).set({
    notifyState: settlement.state, notifyAttempts: group.notifyAttempts + 1, notifyLeaseOwner: null,
    notifyLeaseExpiresAt: settlement.state === "pending" ? sessionTimestampFromEpochMs(settlement.retryAt) : null,
    notifiedAt: settlement.state === "delivered" ? sessionTimestampFromEpochMs(now.getTime()) : null,
  }).where(and(
    eq(Groups.organizationId, group.organizationId), eq(Groups.id, group.id), eq(Groups.notifyState, "pending"),
    eq(Groups.notifyLeaseOwner, group.notifyLeaseOwner), gt(Groups.notifyLeaseExpiresAt, sessionTimestampFromEpochMs(now.getTime())),
  ))
  return updatedGroups(result)
}

export async function retryHarnessFeedbackGroup(organizationId: DenTypeId<"organization">, groupId: DenTypeId<"harnessFeedbackGroup">) {
  const result = await db.update(Groups).set({
    notifyState: "pending", notifyAttempts: 0, notifyLeaseOwner: null, notifyLeaseExpiresAt: null, notifiedAt: null,
  }).where(and(eq(Groups.organizationId, organizationId), eq(Groups.id, groupId), eq(Groups.notifyState, "failed")))
  return updatedGroups(result)
}

const reportMetadata = {
  id: Reports.id, organizationId: Reports.organizationId, state: Reports.state,
  surface: Reports.surface, tool: Reports.tool, errorCode: Reports.errorCode, createdAt: Reports.createdAt,
}

export async function listHarnessFeedback(organizationIds: DenTypeId<"organization">[], selectedGroupId?: DenTypeId<"harnessFeedbackGroup">) {
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
    }).from(Groups).where(groupScope).orderBy(...(selectedGroupId ? [desc(eq(Groups.id, selectedGroupId))] : []), desc(Groups.lastSeenAt), desc(Groups.id)).limit(PAGE_SIZE),
    db.select(reportMetadata).from(Reports).where(and(reportScope, isNull(Reports.groupId)))
      .orderBy(desc(sql`${Reports.state} = 'needs_review'`), desc(Reports.createdAt), desc(Reports.id)).limit(PAGE_SIZE),
    db.select({ total: count() }).from(Groups).where(groupScope),
    db.select({
      total: count(), ungrouped: count(sql`case when ${Reports.groupId} is null then 1 end`),
      pending: count(sql`case when ${Reports.state} = 'pending' then 1 end`),
    }).from(Reports).where(reportScope),
  ])
  return {
    summary: { groups: groupTotals?.total ?? 0, reports: reportTotals?.total ?? 0, ungrouped: reportTotals?.ungrouped ?? 0, pending: reportTotals?.pending ?? 0 },
    groups: groups.map((group) => ({ ...group, categoryLabel: harnessFeedbackCategoryLabel(group.category), firstSeenAt: group.firstSeenAt.toISOString(), lastSeenAt: group.lastSeenAt.toISOString() })),
    ungroupedReports: ungroupedReports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })),
  }
}

const reportDetails = { ...reportMetadata, symptom: Reports.symptom, workaround: Reports.workaround }

export async function readUngroupedHarnessFeedbackReport(organizationId: DenTypeId<"organization">, reportId: DenTypeId<"harnessFeedbackReport">) {
  const [report] = await db.$primary.select(reportDetails).from(Reports).where(and(
    eq(Reports.organizationId, organizationId), eq(Reports.id, reportId), isNull(Reports.groupId),
  )).limit(1)
  return report ? { reports: [{ ...report, createdAt: report.createdAt.toISOString() }] } : null
}

export async function readHarnessFeedbackGroup(organizationId: DenTypeId<"organization">, groupId: DenTypeId<"harnessFeedbackGroup">) {
  const [group] = await db.select({ id: Groups.id }).from(Groups)
    .where(and(eq(Groups.organizationId, organizationId), eq(Groups.id, groupId))).limit(1)
  if (!group) return null
  const reports = await db.select(reportDetails)
    .from(Reports).where(and(eq(Reports.organizationId, organizationId), eq(Reports.groupId, groupId)))
    .orderBy(desc(Reports.createdAt), desc(Reports.id)).limit(PAGE_SIZE)
  return { reports: reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })) }
}
