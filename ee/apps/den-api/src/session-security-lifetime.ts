import { and, eq, gt, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import {
  DEFAULT_SESSION_LIMITS,
  organizationSessionLimits,
  sessionExpiresAt,
  strictestSessionLimits,
  type SessionLimits,
} from "./session-security-settings.js"

export async function userSessionLimits(userId: string): Promise<SessionLimits> {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(MemberTable)
    .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .where(and(eq(MemberTable.userId, normalizeDenTypeId("user", userId)), isNull(MemberTable.removedAt)))
  if (rows.length === 0) return DEFAULT_SESSION_LIMITS
  return strictestSessionLimits(rows.map((row) => organizationSessionLimits(row.metadata)))
}

export async function userSessionExpiresAt(userId: string, now: Date, createdAt: Date) {
  return sessionExpiresAt({ limits: await userSessionLimits(userId), now, createdAt })
}

export async function shortenMemberSessions(input: { organizationId: string; limits: SessionLimits; now?: Date }) {
  const now = input.now ?? new Date()
  const idleEnd = new Date(now.getTime() + input.limits.idleSeconds * 1000).toISOString().replace("T", " ").replace("Z", "")
  const latest = input.limits.maxSeconds === null
    ? sql`CAST(${idleEnd} AS DATETIME(3))`
    : sql`LEAST(CAST(${idleEnd} AS DATETIME(3)), DATE_ADD(${AuthSessionTable.createdAt}, INTERVAL ${input.limits.maxSeconds} SECOND))`
  const memberUserIds = db
    .select({ userId: MemberTable.userId })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)), isNull(MemberTable.removedAt)))
  await db
    .update(AuthSessionTable)
    .set({ expiresAt: latest, updatedAt: sql`${AuthSessionTable.updatedAt}` })
    .where(and(
      inArray(AuthSessionTable.userId, memberUserIds),
      gt(AuthSessionTable.expiresAt, latest),
    ))
}
