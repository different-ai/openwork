import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { countBillingUsers } from "./billing-users.js"
import { cache } from "./cache.js"
import { syncInferenceAfterMemberChange } from "./inference.js"
import { syncOrganizationBillingQuantities } from "./stripe-billing.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

export type OrganizationMemberChange = "added" | "removed"

type OrganizationMemberChangeHookInput = {
  organizationId: OrgId
  memberId: MemberId
  /** Members plus unexpired pending invitations: the same users billing counts. */
  memberCount: number
  change: OrganizationMemberChange
}

type OrganizationMemberChangeHook = (input: OrganizationMemberChangeHookInput) => Promise<void>

const organizationMemberChangeHooks: OrganizationMemberChangeHook[] = [
  syncInferenceAfterMemberChange,
  // Team seats, OpenWork Models and OpenWork Web follow the same user count.
  syncOrganizationBillingQuantities,
]

export async function runPostOrganizationMemberChangeHooks(input: {
  organizationId: OrgId
  memberId: MemberId
  change: OrganizationMemberChange
}) {
  // Member add/remove changes both list rendering and membership auth decisions.
  await cache.org.deleteMembers(input.organizationId)
  const memberCount = await countBillingUsers(input.organizationId)
  for (const hook of organizationMemberChangeHooks) {
    await hook({ ...input, memberCount })
  }
}
