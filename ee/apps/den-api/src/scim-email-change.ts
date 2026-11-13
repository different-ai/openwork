import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { ssoDomainsCover } from "./sso-domains.js"

type OrganizationId = typeof SsoConnectionTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id

/** RFC 7644 section 3.12 error for an attribute this connection may not modify. */
export const SCIM_EMAIL_CHANGE_REFUSAL = {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
  status: "400",
  scimType: "mutability",
  detail: "This user's email cannot be changed through SCIM: the current and the new address must both be on an email domain this organization has verified for SSO.",
}

function emailDomain(email: string) {
  return email.split("@")[1] ?? ""
}

/**
 * Whether an organization's SCIM connection may write this email onto an
 * account. An account's email is global: it receives password resets and is
 * shared by every organization the person belongs to, and SCIM can address
 * anyone who is or was a member. So a connection only moves an email between
 * domains its organization has proven it controls (enabled SSO, verified
 * domain), where its identity provider is already the authority for the
 * address. Writing the email the account already has changes nothing and is
 * always fine: identity providers send it on every full update.
 */
export async function scimEmailChangeAllowed(input: {
  userId: UserId
  email: string
  resolveOrganizationId: () => Promise<OrganizationId | null>
}): Promise<boolean> {
  // primary: an earlier SCIM request may have changed the email moments ago.
  const [user] = await db.$primary
    .select({ email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, input.userId))
    .limit(1)
  if (!user) return false
  const current = user.email.trim().toLowerCase()
  const next = input.email.trim().toLowerCase()
  if (current === next) return true

  const organizationId = await input.resolveOrganizationId()
  if (!organizationId) return false
  const connections = await db.$primary
    .select({ connectionDomain: SsoConnectionTable.domain, providerDomain: SsoProviderTable.domain })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(SsoConnectionTable.organizationId, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(and(eq(SsoConnectionTable.organizationId, organizationId), eq(SsoConnectionTable.status, "enabled")))
  const controls = (domain: string) => Boolean(domain)
    && connections.some((row) => ssoDomainsCover(row.connectionDomain, domain) && ssoDomainsCover(row.providerDomain, domain))
  return controls(emailDomain(current)) && controls(emailDomain(next))
}
