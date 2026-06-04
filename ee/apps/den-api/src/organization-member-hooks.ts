import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { syncInferenceAfterMemberChange } from "./inference.js"
import { syncInferenceSubscriptionQuantityAfterMemberChange, syncSeatSubscriptionQuantityAfterMemberChange } from "./stripe-billing.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

export type OrganizationMemberChange = "added" | "removed"

type OrganizationMemberChangeHookInput = {
  organizationId: OrgId
  memberId: MemberId
  memberCount: number
  change: OrganizationMemberChange
}

type OrganizationMemberChangeHook = (input: OrganizationMemberChangeHookInput) => Promise<void>

const organizationMemberChangeHooks: OrganizationMemberChangeHook[] = [
  syncSeatSubscriptionQuantityAfterMemberChange,
  syncInferenceSubscriptionQuantityAfterMemberChange,
  syncInferenceAfterMemberChange,
]

async function countOrganizationMembers(organizationId: OrgId) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
  return Math.max(0, Number(row?.count ?? 0))
}

export async function runPostOrganizationMemberChangeHooks(input: {
  organizationId: OrgId
  memberId: MemberId
  change: OrganizationMemberChange
}) {
  const memberCount = await countOrganizationMembers(input.organizationId)
  for (const hook of organizationMemberChangeHooks) {
    await hook({ ...input, memberCount })
  }
}
