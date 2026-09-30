import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm"
import { MemberTable, OrganizationTable } from "./schema/org"
import { TeamMemberTable } from "./schema/teams"
import {
  GatewayUsageAssignmentTable as A,
  GatewayUsageBucketTable as B,
  GatewayUsageResetTable as R,
} from "./schema/gateway-usage-limits"
import {
  effectiveUsagePolicies,
  usageFail,
  type GatewayUsageScope,
  type UsageTx,
} from "./gateway-usage-read"

type MemberId = GatewayUsageScope["memberId"]
type OrganizationId = GatewayUsageScope["organizationId"]

export async function lockUsageOrganization(tx: UsageTx, organizationId: OrganizationId) {
  const [organization] = await tx
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .for("update")
  if (!organization) return usageFail("organization_not_found", 404, "Organization not found.")
}

export async function usageOrganizationMembers(tx: UsageTx, organizationId: OrganizationId) {
  await lockUsageOrganization(tx, organizationId)
  const members = await tx
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.organizationId, organizationId),
        isNull(MemberTable.removedAt),
        isNotNull(MemberTable.userId),
      ),
    )
    .orderBy(asc(MemberTable.id))
    .for("update")
  return members.map((member) => member.id)
}

export async function usagePolicyMembers(
  tx: UsageTx,
  organizationId: OrganizationId,
  policyId: string,
) {
  await lockUsageOrganization(tx, organizationId)
  const assignments = await tx
    .select()
    .from(A)
    .where(and(eq(A.organizationId, organizationId), eq(A.policyId, policyId)))
    .for("share")
  const members = new Set<MemberId>(
    assignments.some((assignment) => assignment.organization === true)
      ? await usageOrganizationMembers(tx, organizationId)
      : [],
  )
  for (const assignment of assignments) if (assignment.memberId) members.add(assignment.memberId)
  const teams = assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : []))
  if (teams.length) {
    const rows = await tx
      .select({ memberId: TeamMemberTable.orgMembershipId })
      .from(TeamMemberTable)
      .where(inArray(TeamMemberTable.teamId, teams))
      .for("share")
    for (const row of rows) if (row.memberId) members.add(row.memberId)
  }
  return [...members]
}

export async function lockUsageMembers(
  tx: UsageTx,
  organizationId: OrganizationId,
  members: MemberId[],
) {
  for (const memberId of [...new Set(members)].sort())
    await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId)))
      .for("update")
}

export async function withGatewayUsageEntitlementMutation<T>(
  tx: UsageTx,
  organizationId: OrganizationId,
  mutation: () => Promise<T>,
  memberIds: MemberId[],
  now = new Date(),
): Promise<T> {
  await lockUsageOrganization(tx, organizationId)
  const members = [...new Set(memberIds)].sort()
  await lockUsageMembers(tx, organizationId, members)
  const before = new Map<MemberId, Awaited<ReturnType<typeof effectiveUsagePolicies>>>()
  const active = new Map<MemberId, boolean>()
  for (const memberId of members) {
    const [member] = await tx
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId)))
      .for("share")
    active.set(memberId, member?.userId != null && member.removedAt === null)
    before.set(memberId, await effectiveUsagePolicies(tx, { organizationId, memberId }, true))
  }
  const result = await mutation()
  for (const memberId of members) {
    const after = await effectiveUsagePolicies(tx, { organizationId, memberId }, true)
    const [member] = await tx
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId)))
      .for("share")
    const memberChanged =
      active.get(memberId) !== (member?.userId != null && member.removedAt === null)
    const previous = before.get(memberId) ?? []
    const signature = (winner: (typeof after)[number] | undefined) =>
      JSON.stringify(
        winner
          ? [
              winner.policy.id,
              winner.policy.revision,
              winner.limit.costLimitMicroUsd,
              winner.provenance.map((entry) => entry.assignmentId),
            ]
          : null,
      )
    const changed = [
      ...new Set([...previous, ...after].map((winner) => winner.limit.timeframe)),
    ].filter(
      (frame) =>
        memberChanged ||
        signature(previous.find((winner) => winner.limit.timeframe === frame)) !==
          signature(after.find((winner) => winner.limit.timeframe === frame)),
    )
    if (!changed.length) continue
    await tx
      .update(R)
      .set({ status: "expired", pendingBucketId: null })
      .where(
        and(
          eq(R.organizationId, organizationId),
          eq(R.memberId, memberId),
          eq(R.status, "pending"),
          inArray(R.timeframe, changed),
        ),
      )
    await tx
      .update(B)
      .set({ extensionMicroUsd: 0 })
      .where(
        and(
          eq(B.organizationId, organizationId),
          eq(B.memberId, memberId),
          gt(B.resetAt, now),
          or(...changed.map((frame) => eq(B.timeframe, frame))),
        ),
      )
  }
  return result
}
