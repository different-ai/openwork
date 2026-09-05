import { eq } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthApiKeyTable,
  AuthSessionTable,
  AuthUserTable,
  DesktopHandoffGrantTable,
  ExternalIdentityTable,
  MemberTable,
  OAuthAccessTokenTable,
  OAuthClientTable,
  OAuthConsentTable,
  OAuthRefreshTokenTable,
  ScimSyncEventTable,
  WorkerTable,
} from "@openwork-ee/den-db/schema"
import { cache } from "./cache.js"
import { db } from "./db.js"

type UserId = typeof AuthUserTable.$inferSelect.id

export async function deleteGlobalAuthUser(userId: UserId) {
  const memberships = await db
    .select({ organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(eq(MemberTable.userId, userId))
  const sessions = await db
    .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, userId))
  // Grant tombstones must cover exactly the deleted consent set. Snapshot the
  // ids inside the transaction with a locking read so a concurrently authorized
  // consent cannot slip between the snapshot and the delete (Warden RUD-WDK).
  const oauthConsents = await db.transaction(async (tx) => {
    const consentRows = await tx
      .select({ id: OAuthConsentTable.id })
      .from(OAuthConsentTable)
      .where(eq(OAuthConsentTable.userId, userId))
      .for("update")
    await tx.delete(OAuthAccessTokenTable).where(eq(OAuthAccessTokenTable.userId, userId))
    await tx.delete(OAuthRefreshTokenTable).where(eq(OAuthRefreshTokenTable.userId, userId))
    await tx.delete(OAuthConsentTable).where(eq(OAuthConsentTable.userId, userId))
    await tx.update(OAuthClientTable).set({ userId: null }).where(eq(OAuthClientTable.userId, userId))
    await tx.delete(AuthApiKeyTable).where(eq(AuthApiKeyTable.referenceId, userId))
    await tx.delete(AuthSessionTable).where(eq(AuthSessionTable.userId, userId))
    await tx.delete(AuthAccountTable).where(eq(AuthAccountTable.userId, userId))
    await tx.delete(DesktopHandoffGrantTable).where(eq(DesktopHandoffGrantTable.user_id, userId))
    await tx.delete(ExternalIdentityTable).where(eq(ExternalIdentityTable.userId, userId))
    await tx.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.userId, userId))
    await tx.update(MemberTable).set({ userId: null }).where(eq(MemberTable.userId, userId))
    await tx.update(WorkerTable).set({ created_by_user_id: null }).where(eq(WorkerTable.created_by_user_id, userId))
    await tx.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
    return consentRows
  })
  await Promise.all(Array.from(new Set(memberships.map((membership) => membership.organizationId))).map((organizationId) => cache.org.deleteMembers(organizationId)))
  // Auth session cache hits intentionally avoid a DB liveness check; user deletion must clear
  // both token and session-id cache entries for every deleted session instead.
  await Promise.all(sessions.flatMap((session) => [
    cache.auth.revokeSession(session.token),
    cache.auth.revokeSessionId(session.id),
  ]))
  await Promise.all(oauthConsents.map((consent) => cache.auth.revokeGrant(consent.id)))
}
