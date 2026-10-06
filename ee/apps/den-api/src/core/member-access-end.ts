import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { revokeOrganizationApiKeysForMember } from "../api-keys.js"
import { revokeMembershipSessionCredentials } from "../credential-revocation.js"
import { runPostOrganizationMemberChangeHooks } from "../organization-member-hooks.js"
import { withOrganizationMembershipUsageMutation } from "../organization-team-roles.js"
import { coreHooks, runWithAfterCommit, type CoreMemberAccessEndSource, type CoreTx } from "./hooks/index.js"

type MemberRow = typeof MemberTable.$inferSelect
type OrgId = MemberRow["organizationId"]
type MemberId = MemberRow["id"]

// "soft_remove": Core sets removedAt in the same transaction.
// "pre_hard_delete": Better Auth deletes the row after this returns; the
// caller runs `completeHardDeletedMemberAccess` once the row is gone. Never
// call this with a Better Auth adapter transaction open (our transaction
// must commit before Better Auth's delete takes its locks).
export type MemberAccessEndMode = "soft_remove" | "pre_hard_delete"

export type EndMemberAccessResult<F> =
  | { ok: true; members: MemberRow[] }
  | { ok: false; refusal: F }

// The one Core entry point for every path that ends a person's access to an
// organization (W0-P10). It always runs the full `member.removing` chain, so
// credential revocations (security) and grant cleanup (alwaysRun) never
// depend on which path removed the member or on module state.
export async function endMemberAccess<F>(input: {
  organizationId: OrgId
  memberIds: MemberId[]
  source: CoreMemberAccessEndSource
  mode: MemberAccessEndMode
  removedByOrgMemberId?: MemberId | null
  // Runs under the organization lock with the active member rows locked.
  // Return a refusal to abort without changes (validation, removal guards).
  authorize?: (tx: CoreTx, members: MemberRow[]) => Promise<F | null>
}): Promise<EndMemberAccessResult<F>> {
  const memberIds = [...new Set(input.memberIds)].sort()
  // Hooks queue post-commit work (Google credential revocation) that runs
  // before Core revokes API keys and sessions.
  const result = await runWithAfterCommit((afterCommit) => withOrganizationMembershipUsageMutation(input.organizationId, async (tx): Promise<EndMemberAccessResult<F>> => {
    const members = memberIds.length === 0 ? [] : await tx
      .select()
      .from(MemberTable)
      .where(and(
        eq(MemberTable.organizationId, input.organizationId),
        inArray(MemberTable.id, memberIds),
        isNull(MemberTable.removedAt),
      ))
      .orderBy(MemberTable.id)
      .for("update")

    if (input.authorize) {
      const refusal = await input.authorize(tx, members)
      if (refusal !== null) return { ok: false, refusal }
    }
    if (members.length === 0) return { ok: true, members }

    const removedAt = new Date()
    const activeIds = members.map((member) => member.id)
    await coreHooks.runTx("member.removing", {
      tx,
      organizationId: input.organizationId,
      memberIds: activeIds,
      removedAt,
      afterCommit,
    })

    if (input.mode === "soft_remove") {
      await tx
        .update(MemberTable)
        .set({ removedAt, removedByOrgMember: input.removedByOrgMemberId ?? null })
        .where(and(
          eq(MemberTable.organizationId, input.organizationId),
          inArray(MemberTable.id, activeIds),
          isNull(MemberTable.removedAt),
        ))
    }

    return { ok: true, members }
  }, memberIds))

  if (!result.ok) return result

  for (const member of result.members) {
    await revokeOrganizationApiKeysForMember({
      organizationId: input.organizationId,
      orgMembershipId: member.id,
      userId: member.userId,
    })
    await revokeMembershipSessionCredentials({
      organizationId: input.organizationId,
      userId: member.userId,
    })
  }

  if (input.mode === "soft_remove") {
    for (const member of result.members) {
      await runPostOrganizationMemberChangeHooks({
        organizationId: input.organizationId,
        memberId: member.id,
        change: "removed",
        source: input.source,
      })
    }
  }

  return result
}

// After Better Auth physically deleted a member that went through
// `endMemberAccess({ mode: "pre_hard_delete" })`: `member.removed` re-runs the
// credential revocation (closing the window in which a concurrent mint could
// land between our transaction and Better Auth's delete) and the post-change
// chain (OpenWork Models providers, billing quantities).
export async function completeHardDeletedMemberAccess(input: {
  organizationId: OrgId
  memberId: MemberId
  source: CoreMemberAccessEndSource
}) {
  await runPostOrganizationMemberChangeHooks({
    organizationId: input.organizationId,
    memberId: input.memberId,
    change: "removed",
    source: input.source,
  })
}
