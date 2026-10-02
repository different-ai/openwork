import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"

/**
 * Members that are people: not removed, and not the sign-in-less setup agent
 * that holds a provisional workspace until someone claims it. Use this for
 * seat counts, member lists, and invitation seat eligibility. Authorization
 * (the agent acting for its own workspace) keeps using plain membership.
 */
export function peopleMemberCondition() {
  return and(isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false))
}
