import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, HeadlessResumeRevocationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"

export type ResumeTable = "headless_resume_grant" | "headless_resume_revocation"
const RESUME_TABLES: ResumeTable[] = ["headless_resume_grant", "headless_resume_revocation"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isMissingResumeTableError(error: unknown, table?: ResumeTable): boolean {
  if (!isRecord(error)) return false
  const message = typeof error.message === "string" ? error.message : ""
  const names = (table ? [table] : RESUME_TABLES).some((name) => new RegExp(`\\b${name}\\b`).test(message))
  if ((error.errno === 1146 || error.code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist")) && names) return true
  return isMissingResumeTableError(error.cause, table) || isMissingResumeTableError(error.body, table)
}

export async function unlessResumeTableMissing(table: ResumeTable, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (!isMissingResumeTableError(error, table)) throw error
  }
}

type OrganizationId = typeof HeadlessResumeGrantTable.$inferSelect.organizationId
type UserId = typeof HeadlessResumeGrantTable.$inferSelect.userId

export async function revokeHeadlessResumeGrantsForMember(input: { organizationId: OrganizationId; userId: UserId; now?: Date }): Promise<number> {
  const now = input.now ?? new Date()
  let watermarkError: unknown = null
  try {
    await db
      .insert(HeadlessResumeRevocationTable)
      .values({ organizationId: input.organizationId, userId: input.userId, revokedAt: now })
      .onDuplicateKeyUpdate({ set: { revokedAt: sql`greatest(${HeadlessResumeRevocationTable.revokedAt}, values(revoked_at))` } })
  } catch (error) {
    if (!isMissingResumeTableError(error, "headless_resume_revocation")) throw error
    watermarkError = error
  }
  let revoked = 0
  try {
    const live = await db.$primary
      .select({ id: HeadlessResumeGrantTable.id })
      .from(HeadlessResumeGrantTable)
      .where(and(
        eq(HeadlessResumeGrantTable.userId, input.userId),
        eq(HeadlessResumeGrantTable.organizationId, input.organizationId),
        isNull(HeadlessResumeGrantTable.revokedAt),
      ))
    if (live.length) {
      await db
        .update(HeadlessResumeGrantTable)
        .set({ revokedAt: now })
        .where(inArray(HeadlessResumeGrantTable.id, live.map((row) => row.id)))
      revoked = live.length
    }
  } catch (error) {
    if (isMissingResumeTableError(error, "headless_resume_grant")) return 0
    throw error
  }
  if (watermarkError) throw watermarkError
  return revoked
}
