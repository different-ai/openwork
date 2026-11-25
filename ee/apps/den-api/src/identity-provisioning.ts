import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, ScimProviderTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { emailDomainMatches } from "./account-linking-policy.js"
import { db } from "./db.js"
import { getOrganizationEntitlements } from "./entitlements.js"
import { acceptPendingInvitationForBootstrapMembership, ensureBootstrapMembershipForOrganization } from "./orgs.js"
import { resolveStoredScimProvider } from "./scim-token-storage.js"
import { restoreScimProvisionedMembership } from "./scim-reprovisioning.js"
import { readSsoPerOrganization } from "./organization-sso-access.js"
import { allowsVerifiedDomainAutoJoin, readOrganizationSsoPolicy, ORGANIZATION_SSO_JIT_ROLE } from "@openwork-ee/den-sso"
import { getOrganizationSeatAddEligibility } from "./stripe-billing.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

export const SSO_INVITATION_REQUIRED_MESSAGE = "Ask a workspace admin to invite you, then sign in with SSO again."
export const SCIM_ENTERPRISE_REQUIRED_MESSAGE = "SCIM provisioning requires an Enterprise plan, and the workspace must have room for another user. Invite people from OpenWork instead."

type ProvisioningKind = "scim" | "sso"

export async function organizationAllowsProvisioning(organizationId: OrgId, kind: ProvisioningKind) {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  if (!organization) return false
  if (!getOrganizationEntitlements(organization.metadata)[kind]) return false
  return (await getOrganizationSeatAddEligibility(organizationId)).allowed
}

async function hasMemberRow(organizationId: OrgId, userId: UserId) {
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId)))
    .limit(1)
  return Boolean(member)
}

export type SsoMembershipResult = "member" | "joined_by_invitation" | "provisioned" | "invitation_required"

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

  const placeholder = await acceptPendingInvitationForBootstrapMembership({
    organizationId: input.organizationId,
    userId: input.userId,
    email: input.email,
    defaultRole: ORGANIZATION_SSO_JIT_ROLE,
    afterSsoAdmission: true,
  })
  if (placeholder) return "joined_by_invitation"

  await ensureBootstrapMembershipForOrganization({
    organizationId: input.organizationId,
    userId: input.userId,
    role: ORGANIZATION_SSO_JIT_ROLE,
    email: input.email,
  })
  return "provisioned"
}

export async function provisionVerifiedDomainMembership(input: { userId: UserId; email: string; emailVerified: boolean }) {
  if (!input.emailVerified) return
  const emailDomain = input.email.trim().toLowerCase().split("@")[1]
  if (!emailDomain) return
  const providers = await db
    .select({ organizationId: SsoProviderTable.organizationId, domain: SsoProviderTable.domain, metadata: OrganizationTable.metadata })
    .from(SsoProviderTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, SsoProviderTable.organizationId))
    .where(eq(SsoProviderTable.domainVerified, true))
  const provider = providers.find((entry) => emailDomainMatches(emailDomain, entry.domain))
  if (!provider) return
  const perOrganization = (await readSsoPerOrganization([provider.organizationId])).get(provider.organizationId) === true
  if (!allowsVerifiedDomainAutoJoin({ policy: readOrganizationSsoPolicy(provider.metadata), perOrganization })) return
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

export async function scimRequestOrganizationId(authorization: string | null | undefined): Promise<OrgId | null> {
  const token = bearerToken(authorization)
  if (!token) return null
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

export async function finishScimProvisionedMember(input: { organizationId: OrgId; userId: UserId }) {
  await restoreScimProvisionedMembership(input)
}
