import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export async function getInitialActiveOrganizationIdForUser(userId: string) {
  const normalizedUserId = normalizeDenTypeId("user", userId)

  const rows = await db
    .select({
      organizationId: MemberTable.organizationId,
    })
    .from(MemberTable)
    .where(and(eq(MemberTable.userId, normalizedUserId), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))
    .limit(1)

  return rows[0]?.organizationId ?? null
}
