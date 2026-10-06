import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthApiKeyTable,
  AuthSessionTable,
  AuthUserTable,
  DesktopHandoffGrantTable,
  MemberTable,
  OAuthAccessTokenTable,
  OAuthClientTable,
  OAuthConsentTable,
  OAuthRefreshTokenTable,
} from "@openwork-ee/den-db/schema"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { coreHooks, runWithAfterCommit, type CoreMemberAccessEndSource } from "./hooks/index.js"
import { endMemberAccess } from "./member-access-end.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type MemberRow = typeof MemberTable.$inferSelect

export type UserAccountDeletionSource = Extract<CoreMemberAccessEndSource, "user_delete" | "admin_user_delete" | "scim_deprovision">

// The one user-deletion implementation (W0-P10), used by SCIM deprovisioning
// and admin user delete. Every still-active membership first goes through
// `endMemberAccess`, so each organization runs the full `member.removing`
// chain (credentials, connected accounts, grants) and the post-change chain
// (OpenWork Models providers, billing quantities). Then `user.deleting` and
// the identity purge run in one transaction.
export async function deleteUserAccount(userId: UserId, options: { source: UserAccountDeletionSource }) {
  const activeMemberships = await db
    .select({ id: MemberTable.id, organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, userId), isNull(MemberTable.removedAt)))
  // Sorted organization then member order keeps lock acquisition stable.
  const membersByOrganization = new Map<MemberRow["organizationId"], MemberRow["id"][]>()
  for (const membership of activeMemberships) {
    const memberIds = membersByOrganization.get(membership.organizationId) ?? []
    memberIds.push(membership.id)
    membersByOrganization.set(membership.organizationId, memberIds)
  }
  const organizationIds = [...membersByOrganization.keys()].sort()
  for (const organizationId of organizationIds) {
    await endMemberAccess<never>({
      organizationId,
      memberIds: membersByOrganization.get(organizationId) ?? [],
      source: options.source,
      mode: "soft_remove",
    })
  }

  const memberships = await db
    .select({ organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(eq(MemberTable.userId, userId))
  const sessions = await db
    .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, userId))
  // Module hooks queue post-commit work (Google credential revocation) that
  // runs before Core clears its caches, as it did inline before.
  // Grant tombstones must cover exactly the deleted consent set. Snapshot the
  // ids inside the transaction with a locking read so a concurrently authorized
  // consent cannot slip between the snapshot and the delete (Warden RUD-WDK).
  const { oauthConsents } = await runWithAfterCommit((afterCommit) => db.transaction(async (tx) => {
    const members = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(eq(MemberTable.userId, userId)).orderBy(MemberTable.id).for("update")
    // Covers memberships removed earlier too: revocation is idempotent.
    await coreHooks.runTx("user.deleting", { tx, userId, memberIds: members.map((member) => member.id), afterCommit })
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
    await tx.update(MemberTable).set({ userId: null }).where(eq(MemberTable.userId, userId))
    await tx.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
    return { oauthConsents: consentRows }
  }))
  await Promise.all(Array.from(new Set(memberships.map((membership) => membership.organizationId))).map((organizationId) => cache.org.deleteMembers(organizationId)))
  // Auth session cache hits intentionally avoid a DB liveness check; user deletion must clear
  // both token and session-id cache entries for every deleted session instead.
  await Promise.all(sessions.flatMap((session) => [
    cache.auth.revokeSession(session.token),
    cache.auth.revokeSessionId(session.id),
  ]))
  await Promise.all(oauthConsents.map((consent) => cache.auth.revokeGrant(consent.id)))
}
