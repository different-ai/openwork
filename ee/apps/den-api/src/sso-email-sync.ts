import { and, eq, ne } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { decideSsoEmailSync } from "./sso-email-sync-policy.js"
import { cache } from "./cache.js"
import { recordEmailChangedByIdentityProvider } from "./audit/domain/account.js"

// ENG-815: an identity provider renamed a member's email. When the
// SSO sign-in matched the existing Den user by the provider's account id, the
// IdP is the source of truth for that person's work email, so Den follows the
// rename instead of keeping a stale address that no longer signs in.

/**
 * Applies the decision. Returns the email the user has afterwards. Never takes
 * an address another Den user already holds (the unique email index would
 * reject it anyway); that case keeps the old email and needs an admin.
 */
export async function syncSsoUserEmail(input: Readonly<{
  userId: string
  currentEmail: string
  idpEmail: string | null
  provider: Readonly<{ domain: string; domainVerified?: boolean | null }>
}>): Promise<string> {
  const decision = decideSsoEmailSync({
    currentEmail: input.currentEmail,
    idpEmail: input.idpEmail,
    providerDomain: input.provider.domain,
    providerDomainVerified: input.provider.domainVerified === true,
  })
  if (decision.action === "skip") return input.currentEmail

  const userId = normalizeDenTypeId("user", input.userId)
  const taken = await db
    .select({ id: AuthUserTable.id })
    .from(AuthUserTable)
    .where(and(eq(AuthUserTable.email, decision.email), ne(AuthUserTable.id, userId)))
    .limit(1)
  if (taken.length > 0) {
    console.warn("[den-api] sso_email_sync_skipped_email_taken", { userId })
    return input.currentEmail
  }

  await db
    .update(AuthUserTable)
    .set({ email: decision.email, emailVerified: true, updatedAt: new Date() })
    .where(eq(AuthUserTable.id, userId))
  // The session created a moment ago cached the old email; drop it.
  await cache.auth.deleteSessionsForUser(userId)
  await recordEmailChangedByIdentityProvider(userId)
  return decision.email
}
