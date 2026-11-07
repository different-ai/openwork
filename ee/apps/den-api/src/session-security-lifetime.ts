/**
 * Session length and maximum session length (feature
 * `sessionSecuritySettings`) applied to session rows. The rules are in
 * session-security-settings.ts; this module reads the organizations a person
 * belongs to and writes expiry times.
 *
 * Read only when a session is created or extended (at most once per
 * sessionUpdateAgeSeconds), never on every request.
 */

import { and, eq, gt, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { getFeaturesForOrganizations } from "./features.js"
import {
  DEFAULT_SESSION_LIMITS,
  organizationSessionLimits,
  sessionExpiresAt,
  strictestSessionLimits,
  type SessionLimits,
} from "./session-security-settings.js"

/**
 * A person's session limits: the strictest of their organizations' (one
 * session opens all of them); 7 days without activity and no maximum when
 * none sets them.
 */
export async function userSessionLimits(userId: string): Promise<SessionLimits> {
  const rows = await db
    .select({ organizationId: OrganizationTable.id, metadata: OrganizationTable.metadata })
    .from(MemberTable)
    .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .where(and(eq(MemberTable.userId, normalizeDenTypeId("user", userId)), isNull(MemberTable.removedAt)))
  if (rows.length === 0) return DEFAULT_SESSION_LIMITS
  const features = await getFeaturesForOrganizations(rows.map((row) => row.organizationId))
  return strictestSessionLimits(rows.flatMap((row) => {
    const organizationFeatures = features.get(row.organizationId)
    return organizationFeatures ? [organizationSessionLimits({ features: organizationFeatures, metadata: row.metadata })] : []
  }))
}

/** When the person's session, signed in at `createdAt`, expires if used `now`. */
export async function userSessionExpiresAt(userId: string, now: Date, createdAt: Date) {
  return sessionExpiresAt({ limits: await userSessionLimits(userId), now, createdAt })
}

/**
 * After an organization shortens its limits: every member's live session
 * ends no later than the new length from now, and no later than the new
 * maximum from its sign-in, so the change applies without waiting for each
 * session's next extension. Never lengthens one. Sessions read from the cache
 * keep their old expiry for up to an hour.
 */
export async function shortenMemberSessions(input: { organizationId: string; limits: SessionLimits; now?: Date }) {
  const now = input.now ?? new Date()
  // As Drizzle writes timestamp columns: UTC, without the zone suffix.
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
    .set({ expiresAt: latest, updatedAt: now })
    .where(and(
      inArray(AuthSessionTable.userId, memberUserIds),
      gt(AuthSessionTable.expiresAt, latest),
    ))
}
