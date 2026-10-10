import { and, asc, eq, inArray, isNull, or } from "./drizzle"
import { DesktopPolicyMemberTable, DesktopPolicyTable, MemberTable, TeamMemberTable, TeamTable } from "./schema"
import type { createDenDb } from "./client"
import { listAuthoritativeTeamMemberships } from "./permissions"
import {
  allDesktopPolicies, calculateEffectiveDesktopPolicy, matchingDesktopPolicyAssignmentRoles,
  normalizeDesktopPolicyDocument, resolveDesktopExecutionPolicy, selectEffectiveOnboardingPromptConfig,
  type DesktopConfig, type DesktopPolicyValue,
} from "@openwork/types/den/desktop-policies"

type Db = ReturnType<typeof createDenDb>["db"]
type Database = Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
type OrgId = typeof DesktopPolicyTable.$inferSelect.organizationId
type OrgMemberId = typeof DesktopPolicyTable.$inferSelect.createdByOrgMemberId
type EffectiveDesktopPolicyConfig = Required<DesktopPolicyValue> & Pick<DesktopConfig, "onboardingPrompts" | "onboardingPromptDescriptions" | "execution">

async function listTeamsForOrgMember(database: Database, input: { organizationId: OrgId; orgMemberId: OrgMemberId }) {
  return database.select({ id: TeamTable.id }).from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.orgMemberId)))
}

/** Den and Gateway resolve the same current defaults, roles, teams and member assignments. */
export async function readDesktopPolicyForOrgMember(database: Database, input: {
  organizationId: OrgId
  orgMemberId: OrgMemberId
}): Promise<EffectiveDesktopPolicyConfig> {
  const orgPolicies = await database
    .select({
      id: DesktopPolicyTable.id,
      isDefault: DesktopPolicyTable.isDefault,
      isEnabled: DesktopPolicyTable.isEnabled,
      priority: DesktopPolicyTable.priority,
      policy: DesktopPolicyTable.policy,
      createdAt: DesktopPolicyTable.createdAt,
    })
    .from(DesktopPolicyTable)
    .where(and(
      eq(DesktopPolicyTable.organizationId, input.organizationId),
      isNull(DesktopPolicyTable.deletedAt),
    ))
    .orderBy(asc(DesktopPolicyTable.createdAt))

  if (orgPolicies.length === 0) {
    return allDesktopPolicies(true)
  }

  const defaultPolicy = orgPolicies.find((policy) => policy.isDefault === true && policy.isEnabled === true) ?? null
  const memberRows = await database
    .select({ role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      eq(MemberTable.id, input.orgMemberId),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  const memberRole = memberRows[0]?.role ?? null
  const teams = await listTeamsForOrgMember(database, input)
  const adminTeams = await listAuthoritativeTeamMemberships(database, {
    organizationId: input.organizationId,
    memberId: input.orgMemberId,
    adminTeamsOnly: true,
  })
  const teamIds = teams.map((team) => team.id)
  // Admin assignments follow effective admin status: a direct admin role or
  // an Admin team, with the same SCIM projection rule as den-api's authority.
  const matchingRoles = memberRole
    ? matchingDesktopPolicyAssignmentRoles(memberRole, { adminViaTeam: adminTeams.length > 0 })
    : []
  const assignedWhere = teamIds.length > 0
    ? or(
        eq(DesktopPolicyMemberTable.orgMemberId, input.orgMemberId),
        inArray(DesktopPolicyMemberTable.teamId, teamIds),
        inArray(DesktopPolicyMemberTable.role, matchingRoles),
      )
    : or(
        eq(DesktopPolicyMemberTable.orgMemberId, input.orgMemberId),
        inArray(DesktopPolicyMemberTable.role, matchingRoles),
      )

  const assignedPolicies = assignedWhere
    ? await database
        .select({
          id: DesktopPolicyTable.id,
          priority: DesktopPolicyTable.priority,
          policy: DesktopPolicyTable.policy,
          createdAt: DesktopPolicyTable.createdAt,
        })
        .from(DesktopPolicyMemberTable)
        .innerJoin(DesktopPolicyTable, eq(DesktopPolicyMemberTable.desktopPolicyId, DesktopPolicyTable.id))
        .where(and(
          eq(DesktopPolicyTable.organizationId, input.organizationId),
          eq(DesktopPolicyTable.isEnabled, true),
          isNull(DesktopPolicyTable.deletedAt),
          assignedWhere,
        ))
    : []
  const assignedPoliciesById = new Map<string, (typeof assignedPolicies)[number]>()
  for (const policy of assignedPolicies) {
    if (!assignedPoliciesById.has(policy.id)) {
      assignedPoliciesById.set(policy.id, policy)
    }
  }
  const uniqueAssignedPolicies = [...assignedPoliciesById.values()]

  const effectivePolicy = calculateEffectiveDesktopPolicy({
    orgPolicyCount: orgPolicies.length,
    defaultPolicy: defaultPolicy?.policy ?? {},
    assignedPolicies: uniqueAssignedPolicies.map((row) => row.policy),
  })
  const onboardingPromptConfig = selectEffectiveOnboardingPromptConfig({
    defaultPolicy: defaultPolicy?.policy ?? {},
    assignedPolicies: uniqueAssignedPolicies.map((row) => ({
      id: row.id,
      priority: row.priority,
      createdAt: row.createdAt,
      policy: normalizeDesktopPolicyDocument(row.policy),
    })),
  })

  return {
    ...effectivePolicy,
    execution: resolveDesktopExecutionPolicy([defaultPolicy?.policy, ...uniqueAssignedPolicies.map((row) => row.policy)]),
    ...(onboardingPromptConfig !== undefined ? onboardingPromptConfig : {}),
  }
}
