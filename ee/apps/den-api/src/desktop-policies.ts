import { and, asc, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  DesktopPolicyMemberTable,
  DesktopPolicyTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  allDesktopPolicies,
  calculateEffectiveDesktopPolicy,
  desktopPolicyDefaults,
  normalizeDesktopPolicyValue,
  type DesktopPolicyValue,
} from "@openwork/types/den/desktop-policies"
import { db } from "./db.js"

export type DesktopPolicyId = typeof DesktopPolicyTable.$inferSelect.id
export type DesktopPolicyRow = typeof DesktopPolicyTable.$inferSelect
export type DesktopPolicyMemberRow = typeof DesktopPolicyMemberTable.$inferSelect
export type OrgId = typeof DesktopPolicyTable.$inferSelect.organizationId
export type OrgMemberId = typeof DesktopPolicyTable.$inferSelect.createdByOrgMemberId
export type TeamId = typeof TeamTable.$inferSelect.id

export const DEFAULT_DESKTOP_POLICY_NAME = "Default desktop policy"

export async function ensureDefaultDesktopPolicyForOrganization(input: {
  organizationId: OrgId
  createdByOrgMemberId: OrgMemberId
}) {
  const existing = await db
    .select({ id: DesktopPolicyTable.id })
    .from(DesktopPolicyTable)
    .where(and(
      eq(DesktopPolicyTable.organizationId, input.organizationId),
      eq(DesktopPolicyTable.isDefault, true),
      isNull(DesktopPolicyTable.deletedAt),
    ))
    .limit(1)

  if (existing[0]) {
    return existing[0].id
  }

  const id = createDenTypeId("desktopPolicy")
  await db.insert(DesktopPolicyTable).values({
    id,
    organizationId: input.organizationId,
    policyName: DEFAULT_DESKTOP_POLICY_NAME,
    isDefault: true,
    isEnabled: true,
    policy: desktopPolicyDefaults,
    createdByOrgMemberId: input.createdByOrgMemberId,
  })

  return id
}

export async function listTeamIdsForOrgMember(input: {
  organizationId: OrgId
  orgMemberId: OrgMemberId
}) {
  const rows = await db
    .select({ id: TeamTable.id })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(
      eq(TeamTable.organizationId, input.organizationId),
      eq(TeamMemberTable.orgMembershipId, input.orgMemberId),
    ))

  return rows.map((row) => row.id)
}

export async function calculateDesktopPolicyForOrgMember(input: {
  organizationId: OrgId
  orgMemberId: OrgMemberId
}): Promise<Required<DesktopPolicyValue>> {
  const orgPolicies = await db
    .select({
      id: DesktopPolicyTable.id,
      isDefault: DesktopPolicyTable.isDefault,
      isEnabled: DesktopPolicyTable.isEnabled,
      policy: DesktopPolicyTable.policy,
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
  const teamIds = await listTeamIdsForOrgMember(input)
  const assignedWhere = teamIds.length > 0
    ? or(
        eq(DesktopPolicyMemberTable.orgMemberId, input.orgMemberId),
        inArray(DesktopPolicyMemberTable.teamId, teamIds),
      )
    : eq(DesktopPolicyMemberTable.orgMemberId, input.orgMemberId)

  const assignedPolicies = assignedWhere
    ? await db
        .select({ policy: DesktopPolicyTable.policy })
        .from(DesktopPolicyMemberTable)
        .innerJoin(DesktopPolicyTable, eq(DesktopPolicyMemberTable.desktopPolicyId, DesktopPolicyTable.id))
        .where(and(
          eq(DesktopPolicyTable.organizationId, input.organizationId),
          eq(DesktopPolicyTable.isEnabled, true),
          isNull(DesktopPolicyTable.deletedAt),
          assignedWhere,
        ))
    : []

  return calculateEffectiveDesktopPolicy({
    orgPolicyCount: orgPolicies.length,
    defaultPolicy: defaultPolicy?.policy ?? {},
    assignedPolicies: assignedPolicies.map((row) => normalizeDesktopPolicyValue(row.policy)),
  })
}
