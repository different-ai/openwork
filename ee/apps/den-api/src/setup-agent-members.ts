import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"

export function peopleMemberCondition() {
  return and(isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false))
}
