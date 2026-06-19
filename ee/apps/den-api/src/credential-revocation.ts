import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  MemberTable,
  OAuthAccessTokenTable,
  OAuthRefreshTokenTable,
} from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthSessionTable.$inferSelect.userId

export type MembershipCredentialRevocationCounts = {
  sessions: number
  oauthAccessTokens: number
  oauthRefreshTokens: number
}

export async function revokeMembershipSessionCredentials(input: {
  organizationId: OrganizationId
  userId: UserId | null
}): Promise<MembershipCredentialRevocationCounts> {
  if (!input.userId) {
    return { sessions: 0, oauthAccessTokens: 0, oauthRefreshTokens: 0 }
  }

  const sessions = await db
    .select({ id: AuthSessionTable.id })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, input.userId))

  if (sessions.length > 0) {
    // Auth sessions are user-scoped credentials. Revoke them all so a live
    // session cannot re-select the changed organization and mint new tokens.
    await db
      .delete(AuthSessionTable)
      .where(inArray(AuthSessionTable.id, sessions.map((session) => session.id)))
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
