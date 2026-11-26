import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PersonalAgentAudienceTable, PersonalAgentShareTable, PersonalAgentTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentAudience, SetPersonalAgentAudience } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"
import { activePersonalAgentMember, organizationAllowsPersonalAgentSharing, PERSONAL_AGENT_SHARING_ADMINS_ONLY, type PersonalAgentCaller } from "./access.js"
import { recordPersonalAgentEvent } from "./events.js"

type AgentRow = typeof PersonalAgentTable.$inferSelect

export const EMPTY_PERSONAL_AGENT_AUDIENCE: PersonalAgentAudience = { organization: false, autoAddOrganization: false, teams: [] }
export const PERSONAL_AGENT_NOT_SHARED = "personal_agent_not_shared"
export const PERSONAL_AGENT_INVALID_TEAM = "personal_agent_invalid_team"

export async function personalAgentAudiences(organization: string, agentIds: AgentRow["id"][]): Promise<Map<string, PersonalAgentAudience>> {
  const organizationId = normalizeDenTypeId("organization", organization)
  const rows = await db.$primary.select({
    agentId: PersonalAgentAudienceTable.agent_id,
    key: PersonalAgentAudienceTable.audience_key,
    autoAdd: PersonalAgentAudienceTable.auto_add,
    teamId: TeamTable.id,
    teamName: TeamTable.name,
  }).from(PersonalAgentAudienceTable)
    .leftJoin(TeamTable, and(eq(TeamTable.id, PersonalAgentAudienceTable.team_id), eq(TeamTable.organizationId, organizationId)))
    .where(and(eq(PersonalAgentAudienceTable.organization_id, organizationId), inArray(PersonalAgentAudienceTable.agent_id, agentIds)))
    .orderBy(asc(TeamTable.name), asc(TeamTable.id))
  const audiences = new Map<string, PersonalAgentAudience>()
  for (const row of rows) {
    let audience = audiences.get(row.agentId)
    if (!audience) audiences.set(row.agentId, audience = { organization: false, autoAddOrganization: false, teams: [] })
    if (row.key === "organization") {
      audience.organization = true
      audience.autoAddOrganization = row.autoAdd
    } else if (row.teamId && row.teamName !== null) {
      audience.teams.push({ teamId: row.teamId, name: row.teamName, autoAdd: row.autoAdd })
    }
  }
  return audiences
}

export async function replacePersonalAgentAudience(caller: PersonalAgentCaller, id: string, input: SetPersonalAgentAudience, mode: "member" | "admin") {
  if (!isDenTypeId("personalAgent", id)) return null
  const agentId = normalizeDenTypeId("personalAgent", id)
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const result = await db.transaction(async (tx) => {
    const [agent] = await tx.select().from(PersonalAgentTable).where(and(
      eq(PersonalAgentTable.id, agentId), eq(PersonalAgentTable.organization_id, organizationId),
    )).limit(1).for("update")
    if (!agent || agent.state === "archived") return null
    const shareFilter = and(eq(PersonalAgentShareTable.agent_id, agentId), eq(PersonalAgentShareTable.organization_id, organizationId))
    const audienceFilter = and(eq(PersonalAgentAudienceTable.agent_id, agentId), eq(PersonalAgentAudienceTable.organization_id, organizationId))
    if (mode === "member") {
      if (agent.owner_member_id !== memberId) {
        const [share] = await tx.select({ role: PersonalAgentShareTable.role }).from(PersonalAgentShareTable)
          .where(and(shareFilter, eq(PersonalAgentShareTable.member_id, memberId))).limit(1)
        if (share?.role !== "manager") throw new Error("personal_agent_forbidden")
      }
      if (!await organizationAllowsPersonalAgentSharing(caller, tx)) throw new Error(PERSONAL_AGENT_SHARING_ADMINS_ONLY)
    }
    const existing = await tx.select().from(PersonalAgentAudienceTable).where(audienceFilter)
    if (mode === "admin" && !existing.some((row) => row.audience_key === "organization")) {
      const existingTeams = existing.flatMap((row) => row.team_id ? [row.team_id] : [])
      const [team] = existingTeams.length ? await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(
        eq(TeamTable.organizationId, organizationId), inArray(TeamTable.id, existingTeams))).limit(1).for("share") : []
      const [share] = team ? [] : await tx.select({ id: PersonalAgentShareTable.id }).from(PersonalAgentShareTable)
        .innerJoin(MemberTable, and(eq(MemberTable.id, PersonalAgentShareTable.member_id), eq(MemberTable.organizationId, organizationId), activePersonalAgentMember()))
        .where(shareFilter).limit(1)
      if (!team && !share) throw new Error(PERSONAL_AGENT_NOT_SHARED)
    }
    const teams = new Map<typeof TeamTable.$inferSelect.id, boolean>()
    for (const team of input.teams) {
      if (!isDenTypeId("team", team.teamId)) throw new Error(PERSONAL_AGENT_INVALID_TEAM)
      teams.set(normalizeDenTypeId("team", team.teamId), team.autoAdd ?? false)
    }
    if (teams.size) {
      const valid = await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(
        eq(TeamTable.organizationId, organizationId), inArray(TeamTable.id, [...teams.keys()]),
      )).for("share")
      if (valid.length !== teams.size) throw new Error(PERSONAL_AGENT_INVALID_TEAM)
    }
    const desired = new Map<string, { team_id: typeof TeamTable.$inferSelect.id | null; auto_add: boolean }>()
    if (input.organization) desired.set("organization", { team_id: null, auto_add: input.autoAddOrganization ?? false })
    for (const [teamId, autoAdd] of teams) desired.set(`team:${teamId}`, { team_id: teamId, auto_add: autoAdd })
    const currentByKey = new Map(existing.map((row) => [row.audience_key, row]))
    const removed = existing.filter((row) => !desired.has(row.audience_key))
    if (removed.length) await tx.delete(PersonalAgentAudienceTable).where(inArray(PersonalAgentAudienceTable.id, removed.map((row) => row.id)))
    const changed = [...desired].filter(([key, row]) => currentByKey.get(key)?.auto_add !== row.auto_add)
    const additions = changed.filter(([key]) => !currentByKey.has(key))
    if (additions.length) await tx.insert(PersonalAgentAudienceTable).values(additions.map(([key, row]) => ({
      ...row, id: createDenTypeId("personalAgentAudience"), organization_id: organizationId, agent_id: agentId,
      audience_key: key, created_by_member_id: memberId,
    })))
    for (const [key, row] of changed) {
      const current = currentByKey.get(key)
      if (current) await tx.update(PersonalAgentAudienceTable).set({ auto_add: row.auto_add, updated_at: new Date() })
        .where(eq(PersonalAgentAudienceTable.id, current.id))
    }
    return { agent, changed: Boolean(removed.length || changed.length), teams: teams.size }
  })
  if (!result) return null
  if (result.changed) await recordPersonalAgentEvent({
    organizationId, agentId, actorMemberId: memberId, action: "share.changed",
    detail: { organization: input.organization, teams: result.teams },
  })
  return result.agent
}
