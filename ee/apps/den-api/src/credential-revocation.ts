import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  MemberTable,
  OAuthAccessTokenTable,
  OAuthConsentTable,
  OAuthRefreshTokenTable,
} from "@openwork-ee/den-db/schema"
import { recordOrganizationSessionsRevoked } from "./audit/domain/sessions.js"
import { cache } from "./cache.js"
import { db } from "./db.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthSessionTable.$inferSelect.userId

export type MembershipCredentialRevocationCounts = {
  sessions: number
  oauthAccessTokens: number
  oauthRefreshTokens: number
}

/** Why an organization change revoked the user's sessions (session.revoked reasonCode). */
export type MembershipSessionRevocationReason = "member_removed" | "role_changed" | "role_permissions_changed" | "ownership_transferred"

export async function revokeMembershipSessionCredentials(input: {
  organizationId: OrganizationId
  userId: UserId | null
  /** The affected membership (removed or changed), for the audit event. */
  memberId: string | null
  reason: MembershipSessionRevocationReason
}): Promise<MembershipCredentialRevocationCounts> {
  if (!input.userId) {
    return { sessions: 0, oauthAccessTokens: 0, oauthRefreshTokens: 0 }
  }

  const sessions = await db
    .select({ id: AuthSessionTable.id, token: AuthSessionTable.token, userId: AuthSessionTable.userId, expiresAt: AuthSessionTable.expiresAt, activeOrganizationId: AuthSessionTable.activeOrganizationId })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, input.userId))

  if (sessions.length > 0) {
    // Auth sessions are user-scoped credentials. Revoke them all so a live
    // session cannot re-select the changed organization and mint new tokens.
    await db
      .delete(AuthSessionTable)
      .where(inArray(AuthSessionTable.id, sessions.map((session) => session.id)))
    // Membership removal/role downgrade revokes sessions and clears their cache entries.
    await Promise.all(sessions.flatMap((session) => [
      cache.auth.revokeSession(session.token),
      cache.auth.revokeSessionId(session.id),
    ]))
    // Direct delete: no better-auth hook fires. session.revoked in the affected
    // organization (never blocks or rolls back the revocation).
    await recordOrganizationSessionsRevoked({ organizationId: input.organizationId, memberId: input.memberId, userId: input.userId, sessions, reasonCode: input.reason })
  }

  const oauthAccessTokens = await db
    .select({ id: OAuthAccessTokenTable.id })
    .from(OAuthAccessTokenTable)
    .where(and(
      eq(OAuthAccessTokenTable.userId, input.userId),
      eq(OAuthAccessTokenTable.referenceId, input.organizationId),
    ))

  if (oauthAccessTokens.length > 0) {
    await db
      .delete(OAuthAccessTokenTable)
      .where(inArray(OAuthAccessTokenTable.id, oauthAccessTokens.map((token) => token.id)))
  }

  const oauthConsents = await db
    .select({ id: OAuthConsentTable.id })
    .from(OAuthConsentTable)
    .where(and(
      eq(OAuthConsentTable.userId, input.userId),
      eq(OAuthConsentTable.referenceId, input.organizationId),
    ))

  if (oauthConsents.length > 0) {
    await db
      .delete(OAuthConsentTable)
      .where(inArray(OAuthConsentTable.id, oauthConsents.map((consent) => consent.id)))
    await Promise.all(oauthConsents.map((consent) => cache.auth.revokeGrant(consent.id)))
  }

  const oauthRefreshTokens = await db
    .select({ id: OAuthRefreshTokenTable.id })
    .from(OAuthRefreshTokenTable)
    .where(and(
      eq(OAuthRefreshTokenTable.userId, input.userId),
      eq(OAuthRefreshTokenTable.referenceId, input.organizationId),
      isNull(OAuthRefreshTokenTable.revoked),
    ))

  if (oauthRefreshTokens.length > 0) {
    await db
      .update(OAuthRefreshTokenTable)
      .set({ revoked: new Date() })
      .where(inArray(OAuthRefreshTokenTable.id, oauthRefreshTokens.map((token) => token.id)))
  }

  return {
    sessions: sessions.length,
    oauthAccessTokens: oauthAccessTokens.length,
    oauthRefreshTokens: oauthRefreshTokens.length,
  }
}
