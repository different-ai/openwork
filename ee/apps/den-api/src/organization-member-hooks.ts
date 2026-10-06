import { peopleMemberCondition } from "./setup-agent-members.js"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { cache } from "./cache.js"
import { coreHooks } from "./core/hooks/index.js"
import { db } from "./db.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

async function countOrganizationMembers(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), peopleMemberCondition()))
  return Math.max(0, Number(row?.count ?? 0))
}

// Den invitation create, invitation acceptance and member removal dispatch
// `member.added` / `member.removed` through here. Module reactions are
// registered on the Core hook registry (core/hooks/legacy until each module
// plan moves them).
export async function runPostOrganizationMemberChangeHooks(input: {
  organizationId: OrgId
  memberId: MemberId
} & ({ change: "added"; source: "invitation" | "acceptance" } | { change: "removed" })) {
  // Member add/remove changes both list rendering and membership auth decisions.
  await cache.org.deleteMembers(input.organizationId)
  const memberCount = await countOrganizationMembers(input.organizationId)
  if (input.change === "added") {
    await coreHooks.runPostCommit("member.added", {
      organizationId: input.organizationId,
      memberId: input.memberId,
      source: input.source,
      memberCount,
    })
    return
  }
  await coreHooks.runPostCommit("member.removed", {
    organizationId: input.organizationId,
    memberId: input.memberId,
    memberCount,
    source: "removal",
  })
}
