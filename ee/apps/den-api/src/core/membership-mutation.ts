import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { registeredMembershipMutationParticipants, runMembershipMutationParticipants } from "./hook-seams.js"
import { withOrganizationRowLock } from "./org-row-lock.js"
import type { CoreTx } from "./types.js"

type MemberId = DenTypeId<"member">

// Every membership mutation takes the Core org-row lock, then runs the
// `membership.mutation.participant` chain (usage entitlements, member API key
// pruning, ...) around the body. Participants lock in a fixed order right after
// the org row, so lock order stays org row -> participants -> mutation.
export function withMembershipMutation<T>(
  organizationId: DenTypeId<"organization">,
  mutation: (tx: CoreTx) => Promise<T>,
  // A function is evaluated inside the org-row lock, so the affected members
  // reflect the state the mutation will see.
  memberIds: MemberId[] | ((tx: CoreTx) => Promise<MemberId[]>),
) {
  const { participants, moduleState } = registeredMembershipMutationParticipants()
  return withOrganizationRowLock(organizationId, async (tx) => {
    const affected = [...new Set(typeof memberIds === "function" ? await memberIds(tx) : memberIds)]
    return runMembershipMutationParticipants(participants, { organizationId, memberIds: affected, tx }, () => mutation(tx), moduleState)
  })
}
