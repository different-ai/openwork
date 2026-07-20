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
import { db } from "./db.js"

type UserId = typeof AuthUserTable.$inferSelect.id

export async function deleteGlobalAuthUser(userId: UserId) {
  await db.transaction(async (tx) => {
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
  })
}
