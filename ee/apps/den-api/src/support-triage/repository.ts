import { randomUUID } from "node:crypto"
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { SupportTriageSettingsTable as Settings, SupportTriageThreadTable as Threads } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import type { PlainThreadSummary } from "./plain.js"

const LEASE_MS = 90_000
export const MAX_ATTEMPTS = 3
const activeStatuses = ["pending", "processing"] satisfies Thread["status"][]
type Thread = typeof Threads.$inferSelect
export type ClaimedTriageThread = Thread & { leaseOwner: string; leaseExpiresAt: Date }
export type TriageCategory = NonNullable<Thread["category"]>

export async function enqueueTriagePage(workspaceId: string, revision: string, enabledAt: Date, through: Date, threads: PlainThreadSummary[], now: Date) {
  const rows = threads.filter(({ createdAt }) => createdAt.iso8601 >= enabledAt && createdAt.iso8601 <= through)
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ revision: Settings.revision }).from(Settings).where(eq(Settings.id, "default")).for("share")
    if (current?.revision !== revision) return false
    if (rows.length) await tx.insert(Threads).values(rows.map((thread) => ({
      id: createDenTypeId("supportTriageThread"), workspaceId, plainThreadId: thread.id, createdAt: thread.createdAt.iso8601,
      title: thread.title.slice(0, 512), preview: thread.previewText?.slice(0, 512), nextAttemptAt: now,
    }))).onDuplicateKeyUpdate({ set: { id: sql`${Threads.id}` } })
    return true
  })
}

export async function claimTriageThreads(workspaceId: string, revision: string, enabledAt: Date, now: Date, limit: number): Promise<ClaimedTriageThread[]> {
  const scope = and(eq(Threads.workspaceId, workspaceId), gte(Threads.createdAt, enabledAt), inArray(Threads.status, activeStatuses),
    or(isNull(Threads.leaseExpiresAt), lte(Threads.leaseExpiresAt, now)))
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ revision: Settings.revision }).from(Settings).where(eq(Settings.id, "default")).for("share")
    if (current?.revision !== revision) return []
    await tx.update(Threads).set({ status: "failed", leaseOwner: null, leaseExpiresAt: null })
      .where(and(scope, gte(Threads.attempts, MAX_ATTEMPTS)))
    const rows = await tx.select().from(Threads).where(and(scope, lte(Threads.nextAttemptAt, now), lt(Threads.attempts, MAX_ATTEMPTS)))
      .orderBy(asc(Threads.nextAttemptAt), asc(Threads.id)).limit(limit).for("update", { skipLocked: true })
    if (!rows.length) return []
    const leaseOwner = randomUUID()
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS)
    await tx.update(Threads).set({ status: "processing", leaseOwner, leaseExpiresAt, attempts: sql`${Threads.attempts} + 1` })
      .where(inArray(Threads.id, rows.map(({ id }) => id)))
    return rows.map((row) => ({ ...row, status: "processing", attempts: row.attempts + 1, leaseOwner, leaseExpiresAt }))
  })
}

type Progress = Partial<Pick<Thread, "category" | "judgmentDetail" | "labelApplied" | "dispositionApplied" | "slackState" | "status" | "nextAttemptAt" | "leaseOwner" | "leaseExpiresAt">>

export async function updateTriageThread(row: ClaimedTriageThread, progress: Progress, now: Date) {
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: Threads.id }).from(Threads).where(and(eq(Threads.id, row.id),
      eq(Threads.status, "processing"), eq(Threads.leaseOwner, row.leaseOwner), gt(Threads.leaseExpiresAt, now))).for("update")
    if (!owned) return false
    await tx.update(Threads).set(progress).where(eq(Threads.id, row.id))
    return true
  })
}

export async function listTriageThreads({ category, limit, offset }: { category?: TriageCategory; limit: number; offset: number }) {
  const filter = category ? eq(Threads.category, category) : undefined
  const [rows, [total]] = await Promise.all([
    db.$primary.select({ id: Threads.id, plainThreadId: Threads.plainThreadId, workspaceId: Threads.workspaceId, title: Threads.title,
      preview: Threads.preview, category: Threads.category, status: Threads.status, createdAt: Threads.createdAt, attempts: Threads.attempts,
    }).from(Threads).where(filter).orderBy(desc(Threads.createdAt), desc(Threads.id)).limit(limit).offset(offset),
    db.$primary.select({ value: count() }).from(Threads).where(filter),
  ])
  return { threads: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), total: total?.value ?? 0 }
}
