import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

/**
 * Better Auth's `shouldLinkUser`: an organization's SCIM connection may attach to
 * an existing user matched by email only when that user is known to the
 * organization. That includes a member an admin removed in Den while the
 * identity provider kept them assigned, so the IdP can provision them again.
 */
export function createScimExistingUserLinkCheck(
  isKnownToOrganization: (input: { organizationId: OrganizationId; userId: UserId }) => PromiseLike<boolean>,
) {
  return async ({ user, provider }: {
    user: { id: string }
    provider: { organizationId?: string | null }
  }): Promise<boolean> => {
    if (!provider.organizationId) return false

    return isKnownToOrganization({
      organizationId: normalizeDenTypeId("organization", provider.organizationId),
      userId: normalizeDenTypeId("user", user.id),
    })
  }
}
