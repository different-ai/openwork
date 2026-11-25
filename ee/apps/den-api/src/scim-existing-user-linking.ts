import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type UserId = NonNullable<typeof MemberTable.$inferSelect.userId>

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
