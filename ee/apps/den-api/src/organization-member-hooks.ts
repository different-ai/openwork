import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { countBillingUsers } from "./billing-users.js"
import { cache } from "./cache.js"
import { syncInferenceAfterMemberChange } from "./inference.js"
import { syncOrganizationBillingQuantities } from "./stripe-billing.js"
import { removeMemberWorkbotComputersInBackground } from "./workbot/member-computers.js"
import { deleteRemoteSessionTailsForMember } from "./remote-sessions/tails.js"

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

const removeWorkbotComputersAfterRemoval: OrganizationMemberChangeHook = async (input) => {
  if (input.change === "removed") {
    removeMemberWorkbotComputersInBackground(input)
    await deleteRemoteSessionTailsForMember({ organizationId: input.organizationId, ownerMemberId: input.memberId })
  }
}

const organizationMemberChangeHooks: OrganizationMemberChangeHook[] = [
  syncInferenceAfterMemberChange,
  syncOrganizationBillingQuantities,
  removeWorkbotComputersAfterRemoval,
]

export async function runPostOrganizationMemberChangeHooks(input: {
  organizationId: OrgId
  memberId: MemberId
  change: OrganizationMemberChange
}) {
  await cache.org.deleteMembers(input.organizationId)
  const memberCount = await countBillingUsers(input.organizationId)
  for (const hook of organizationMemberChangeHooks) {
    await hook({ ...input, memberCount })
  }
}
