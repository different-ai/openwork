import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, HeadlessResumeRevocationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"

export type ResumeTable = "headless_resume_grant" | "headless_resume_revocation"
const RESUME_TABLES: ResumeTable[] = ["headless_resume_grant", "headless_resume_revocation"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * MySQL "table doesn't exist" (errno 1146) for a resume grant table (`table`, or either of them), through Drizzle's
 * wrapper (`cause`) or PlanetScale's (`body`). Any other error, including a missing table elsewhere, is not this.
 */
export function isMissingResumeTableError(error: unknown, table?: ResumeTable): boolean {
  if (!isRecord(error)) return false
  const message = typeof error.message === "string" ? error.message : ""
  const names = (table ? [table] : RESUME_TABLES).some((name) => new RegExp(`\\b${name}\\b`).test(message))
  if ((error.errno === 1146 || error.code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist")) && names) return true
  return isMissingResumeTableError(error.cause, table) || isMissingResumeTableError(error.body, table)
}

/**
 * Runs resume-grant cleanup on another flow's path (user deletion) for one table. Until the migration that creates
 * the table has run it holds no rows, so a missing table means nothing to delete and the surrounding flow must not
 * fail because den-api deployed before its migration finished. Every other error is thrown.
 */
export async function unlessResumeTableMissing(table: ResumeTable, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (!isMissingResumeTableError(error, table)) throw error
  }
}

type OrganizationId = typeof HeadlessResumeGrantTable.$inferSelect.organizationId
type UserId = typeof HeadlessResumeGrantTable.$inferSelect.userId

/**
 * Revokes every resume grant (resume-grants.ts) one person holds in one organization, so the headless runner can no
 * longer get tokens for their turns there. Called first in the membership credential revocation path (member
 * removed, role or role permissions changed, ownership transferred), before any token is deleted. Kept apart from
 * resume-grants.ts so the revocation path does not import the token minter. User deletion deletes the rows instead
 * (user-deletion.ts and the admin user deletion route).
 *
 * The revocation moment is recorded first, then live grants are marked revoked. A grant being minted concurrently is
 * not in the sweep, but it was authorized before this moment, so the exchange refuses it (see
 * headlessResumeGrantAuthorizedBeforeRevocation): no ordering of the two writes lets it through.
 *
 * Before the migrations run: with neither table there can be no grant, so there is nothing to revoke. With grants but
 * no revocation table (a half-applied migration), the grants are still marked revoked and then the error is thrown:
 * without the watermark a concurrently minted grant could survive, so the revocation must not report success.
 */
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
    const live = await db
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
    // No grant table yet: no grant can exist, so nothing can survive this revocation.
    if (isMissingResumeTableError(error, "headless_resume_grant")) return 0
    throw error
  }
  if (watermarkError) throw watermarkError
  return revoked
}
