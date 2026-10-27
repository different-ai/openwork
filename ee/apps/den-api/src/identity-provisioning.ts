import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, ScimProviderTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { emailDomainMatches } from "./account-linking-policy.js"
import { db } from "./db.js"
import { getOrganizationEntitlements } from "./entitlements.js"
import { runPostOrganizationMemberChangeHooks } from "./organization-member-hooks.js"
import { acceptPendingInvitationForBootstrapMembership, ensureBootstrapMembershipForOrganization } from "./orgs.js"
import { resolveStoredScimProvider } from "./scim-token-storage.js"
import { ORGANIZATION_SSO_JIT_ROLE } from "./sso-jit.js"
import { getOrganizationSeatAddEligibility } from "./stripe-billing.js"

/**
 * People joining an organization without an invitation:
 *
 * - SCIM provisioning needs the Enterprise plan (`scim` entitlement).
 * - SSO sign-up (just-in-time on sign-in, or signing in with an email on the
 *   organization's verified SSO domain) needs the Team plan (`sso`
 *   entitlement).
 *
 * Both respect the organization's user limit exactly like an invitation
 * (organization-plan.ts): Free allows 5 (or more if a platform admin raised
 * it), a Team or Enterprise plan a platform admin set allows its seats, and a
 * paid Stripe plan has no limit.
 * Invited people always join through their invitation.
 *
 * Better Auth's SCIM and SSO plugins write member rows through the raw adapter,
 * which skips Den's member hooks, so Den provisions and syncs billing here.
 */

type OrgId = typeof OrganizationTable.$inferSelect.id
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

export const SSO_INVITATION_REQUIRED_MESSAGE = "Ask a workspace admin to invite you, then sign in with SSO again."
export const SCIM_ENTERPRISE_REQUIRED_MESSAGE = "SCIM provisioning requires an Enterprise plan, and the workspace must have room for another user. Invite people from OpenWork instead."

type ProvisioningKind = "scim" | "sso"

/**
 * Whether someone may join this organization without an invitation, through
 * SCIM ("scim") or SSO sign-up ("sso"). Reads the organization fresh, so a plan
 * a platform admin sets in /admin applies to the next sign-in or SCIM request.
 */
export async function organizationAllowsProvisioning(organizationId: OrgId, kind: ProvisioningKind) {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  if (!organization) return false
  if (!getOrganizationEntitlements(organization.metadata)[kind]) return false
  // The same user limit as an invitation (organization-plan.ts): a plan a
  // platform admin set allows its seats, a paid Stripe plan has no limit.
  return (await getOrganizationSeatAddEligibility(organizationId)).allowed
}

async function hasMemberRow(organizationId: OrgId, userId: UserId) {
  // Removed members keep their row: they still sign in, without access.
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId)))
    .limit(1)
  return Boolean(member)
}

export type SsoMembershipResult = "member" | "joined_by_invitation" | "provisioned" | "invitation_required"

/**
 * Membership for someone signing in through an organization's SSO connection:
 * invited people join through their invitation on any plan; anyone else joins
 * automatically on Team and Enterprise.
 */
export async function provisionSsoMembership(input: { organizationId: OrgId; userId: UserId; email: string | null }): Promise<SsoMembershipResult> {
  if (await hasMemberRow(input.organizationId, input.userId)) return "member"

  const invited = await acceptPendingInvitationForBootstrapMembership({
    organizationId: input.organizationId,
    userId: input.userId,
    email: input.email,
    defaultRole: ORGANIZATION_SSO_JIT_ROLE,
  })
  if (invited) return "joined_by_invitation"

  if (!await organizationAllowsProvisioning(input.organizationId, "sso")) return "invitation_required"

  // Runs the member hooks: billing follows the new user and a gateway key is issued.
  await ensureBootstrapMembershipForOrganization({
    organizationId: input.organizationId,
    userId: input.userId,
    role: ORGANIZATION_SSO_JIT_ROLE,
    email: input.email,
  })
  return "provisioned"
}

/**
 * Sign-in with another method (e.g. Google) using a verified email on an
 * organization's verified SSO domain joins that organization (Team plan and
 * up), as Better Auth's domain provisioning did, but never with an unverified
 * email.
 */
export async function provisionVerifiedDomainMembership(input: { userId: UserId; email: string; emailVerified: boolean }) {
  // The email's domain is the only proof of belonging here, so the provider
  // must have verified the email; an unverified address could claim any domain.
  if (!input.emailVerified) return
  const emailDomain = input.email.trim().toLowerCase().split("@")[1]
  if (!emailDomain) return
  const providers = await db
    .select({ organizationId: SsoProviderTable.organizationId, domain: SsoProviderTable.domain })
    .from(SsoProviderTable)
    .where(eq(SsoProviderTable.domainVerified, true))
  const provider = providers.find((entry) => emailDomainMatches(emailDomain, entry.domain))
  if (!provider) return
  if (await hasMemberRow(provider.organizationId, input.userId)) return
  if (!await organizationAllowsProvisioning(provider.organizationId, "sso")) return
  await ensureBootstrapMembershipForOrganization({
    organizationId: provider.organizationId,
    userId: input.userId,
    role: ORGANIZATION_SSO_JIT_ROLE,
    email: input.email,
  })
}

function bearerToken(authorization: string | null | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

/** The organization a SCIM request's bearer token belongs to. */
export async function scimRequestOrganizationId(authorization: string | null | undefined): Promise<OrgId | null> {
  const token = bearerToken(authorization)
  if (!token) return null
  // Verified against the stored token hash, like the SCIM endpoints do.
  const provider = await resolveStoredScimProvider(token, async (providerId, organizationId) => {
    const [row] = await db
      .select({ organizationId: ScimProviderTable.organizationId, scimToken: ScimProviderTable.scimToken })
      .from(ScimProviderTable)
      .where(and(eq(ScimProviderTable.providerId, providerId), eq(ScimProviderTable.organizationId, organizationId as OrgId)))
      .limit(1)
    return row ?? null
  })
  return provider?.organizationId ?? null
}

/** After SCIM creates a user in an organization: billing and member setup, like any other join. */
export async function finishScimProvisionedMember(input: { organizationId: OrgId; userId: UserId }) {
  const [member] = await db
    .select({ id: MemberTable.id, removedAt: MemberTable.removedAt })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), eq(MemberTable.userId, input.userId)))
    .limit(1)
  if (!member || member.removedAt) return
  await runPostOrganizationMemberChangeHooks({ organizationId: input.organizationId, memberId: member.id, change: "added" })
}
