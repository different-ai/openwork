import { and, isNull, type SQL } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "./core/hooks/index.js"

// Collected on first use, not at import: this file is imported while the
// legacy registrations load.
let contributedPeopleConditions: SQL[] | null = null

/**
 * Members that are people: not removed, and not the sign-in-less setup agent
 * that holds a provisional workspace until someone claims it. Use this for
 * seat counts, member lists, and invitation seat eligibility. Authorization
 * (the agent acting for its own workspace) keeps using plain membership.
 */
export function peopleMemberCondition() {
  contributedPeopleConditions ??= coreHooks.collectBoot("member.visibilityFilter")
  return and(isNull(MemberTable.removedAt), ...contributedPeopleConditions)
}
