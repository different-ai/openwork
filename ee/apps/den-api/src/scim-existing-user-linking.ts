import { and, eq, isNull, type SQL } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"

export function createScimExistingUserLinkCheck(
  readMembership: (where: SQL | undefined) => PromiseLike<readonly { id: string }[]>,
) {
  return async ({ user, provider }: {
    user: { id: string }
    provider: { organizationId?: string | null }
  }): Promise<boolean> => {
    if (!provider.organizationId) return false

    const members = await readMembership(and(
      eq(MemberTable.userId, normalizeDenTypeId("user", user.id)),
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", provider.organizationId)),
      isNull(MemberTable.removedAt),
    ))
    return members.length > 0
  }
}
