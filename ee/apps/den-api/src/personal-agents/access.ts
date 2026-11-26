import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, PersonalAgentAudienceTable, PersonalAgentOrgPolicyTable, PersonalAgentShareTable, PersonalAgentTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentPerson, PersonalAgentRole } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"

import { listTeamsForMember } from "../member-teams.js"
import { withPrimaryReads } from "../read-routing.js"

export type PersonalAgentCaller = { organizationId: string; memberId: string; isOrgAdmin?: boolean }
export type PersonalAgentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type PersonalAgentAccess = {
  agentId: string
  organizationId: string
  ownerMemberId: string
  role: PersonalAgentRole
  state: "active" | "archived"
  pausedAt: number | null
}

export async function personalAgentAccessRows(caller: PersonalAgentCaller, filter: SQL | undefined, limit: number, fresh = false) {
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const teams = fresh ? await db.$primary.select({ id: TeamTable.id }).from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamMemberTable.orgMembershipId, memberId)))
    : await withPrimaryReads(() => listTeamsForMember({ organizationId, memberId }))
  const ids = teams.map((team) => team.id)
  const teamIds = new Set<string>(ids)
  const audiences = db.$primary.select({ id: PersonalAgentAudienceTable.agent_id }).from(PersonalAgentAudienceTable).where(and(
    eq(PersonalAgentAudienceTable.organization_id, organizationId),
    or(eq(PersonalAgentAudienceTable.audience_key, "organization"), ids.length ? inArray(PersonalAgentAudienceTable.team_id, ids) : undefined),
  ))
  const rows = await db.$primary.select({ agent: PersonalAgentTable, directRole: PersonalAgentShareTable.role }).from(PersonalAgentTable)
    .leftJoin(PersonalAgentShareTable, and(eq(PersonalAgentShareTable.agent_id, PersonalAgentTable.id),
      eq(PersonalAgentShareTable.organization_id, organizationId), eq(PersonalAgentShareTable.member_id, memberId)))
    .where(and(eq(PersonalAgentTable.organization_id, organizationId), filter, or(
      eq(PersonalAgentTable.owner_member_id, memberId), isNotNull(PersonalAgentShareTable.role), inArray(PersonalAgentTable.id, audiences),
    ))).orderBy(desc(PersonalAgentTable.id)).limit(limit)
  return rows.map(({ agent, directRole }) => {
    const role: PersonalAgentRole = agent.owner_member_id === memberId ? "owner" : directRole ?? "collaborator"
    return { agent, role, directlyListed: role === "owner" || directRole !== null, teamIds }
  })
}

export async function personalAgentAccess(caller: PersonalAgentCaller, agentId: string, fresh = false): Promise<PersonalAgentAccess | null> {
  if (!isDenTypeId("personalAgent", agentId)) return null
  const [row] = await personalAgentAccessRows(caller, eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", agentId)), 1, fresh)
  if (!row) return null
  return {
    agentId: row.agent.id,
    organizationId: row.agent.organization_id,
    ownerMemberId: row.agent.owner_member_id,
    role: row.role,
    state: row.agent.state,
    pausedAt: row.agent.paused_at?.getTime() ?? null,
  }
}

export const PERSONAL_AGENT_SHARING_ADMINS_ONLY = "personal_agent_sharing_admins_only"
export const PERSONAL_AGENT_SHARING_ADMINS_ONLY_MESSAGE = "Only admins can share agents in this organization."

export async function organizationAllowsPersonalAgentSharing(caller: PersonalAgentCaller, tx?: PersonalAgentTransaction): Promise<boolean> {
  if (caller.isOrgAdmin) return true
  const query = (tx ?? db.$primary).select({ shareMode: PersonalAgentOrgPolicyTable.share_mode }).from(PersonalAgentOrgPolicyTable)
    .where(eq(PersonalAgentOrgPolicyTable.organization_id, normalizeDenTypeId("organization", caller.organizationId))).limit(1)
  const [policy] = await (tx ? query.for("share") : query)
  return policy?.shareMode !== "admins"
}

export function canManagePersonalAgent(role: PersonalAgentRole): boolean {
  return role === "owner" || role === "manager"
}

export function personalAgentOwnerScope(access: PersonalAgentAccess) {
  return { organizationId: access.organizationId, ownerMemberId: access.ownerMemberId, modelAttentionCapable: true }
}

export async function personalAgentPeople(organizationId: string, memberIds: readonly string[]): Promise<Map<string, PersonalAgentPerson>> {
  const ids = [...new Set(memberIds)].filter((id) => isDenTypeId("member", id)).map((id) => normalizeDenTypeId("member", id))
  if (ids.length === 0) return new Map()
  const rows = await db.$primary.select({ memberId: MemberTable.id, name: AuthUserTable.name }).from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)), inArray(MemberTable.id, ids)))
  return new Map(rows.map((row) => [row.memberId, { memberId: row.memberId, name: row.name }]))
}

export function personOrUnknown(people: Map<string, PersonalAgentPerson>, memberId: string): PersonalAgentPerson {
  return people.get(memberId) ?? { memberId, name: "Someone who left" }
}

export function activePersonalAgentMember() {
  return and(isNull(MemberTable.removedAt), isNotNull(MemberTable.userId), isNotNull(MemberTable.joinedAt), eq(MemberTable.isSetupAgent, false))
}
