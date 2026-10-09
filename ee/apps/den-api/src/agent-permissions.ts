import { and, asc, count, eq, inArray, or } from "@openwork-ee/den-db/drizzle"
import { AgentPermissionPolicyTable, AgentPermissionSettingTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AGENT_PERMISSION_EVERYONE,
  agentPermissionDefinitions,
  normalizeAgentPermissionSetting,
  resolveAgentPermissionRules,
  type AgentPermissionRule,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import { db } from "./db.js"

type OrganizationId = DenTypeId<"organization">
type TeamId = DenTypeId<"team">
type MemberId = DenTypeId<"member">
type PolicyId = DenTypeId<"agentPermissionPolicy">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

const EVERYONE_SCOPE = "everyone"

export type AgentPermissionPolicyRecord = {
  teamId: TeamId | null
  settings: AgentPermissionSettings
  updatedAt: Date | null
}

export type AgentPermissionTeamPolicyRecord = AgentPermissionPolicyRecord & {
  teamId: TeamId
  teamName: string
  memberCount: number
}

/** JSON columns arrive as strings on engines like MariaDB (JSON = LONGTEXT alias). */
function jsonList(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return []
  }
}

async function readSettings(database: Database, policyIds: PolicyId[]): Promise<Map<PolicyId, AgentPermissionSettings>> {
  const settings = new Map<PolicyId, AgentPermissionSettings>()
  if (policyIds.length === 0) return settings
  const rows = await database
    .select()
    .from(AgentPermissionSettingTable)
    .where(inArray(AgentPermissionSettingTable.policyId, policyIds))
  for (const row of rows) {
    const definition = agentPermissionDefinitions.find((entry) => entry.key === row.permissionKey)
    if (!definition) continue
    const setting = normalizeAgentPermissionSetting(definition, {
      decision: row.decision,
      allow: jsonList(row.allowPatterns),
      block: jsonList(row.blockPatterns),
    })
    if (!setting) continue
    const policySettings = settings.get(row.policyId) ?? {}
    policySettings[definition.key] = setting
    settings.set(row.policyId, policySettings)
  }
  return settings
}

/** Members per team, counted as the organization's team lists count them. */
async function teamMemberCounts(teamIds: TeamId[]): Promise<Map<TeamId, number>> {
  if (teamIds.length === 0) return new Map()
  const rows = await db
    .select({ teamId: TeamMemberTable.teamId, members: count(TeamMemberTable.orgMembershipId) })
    .from(TeamMemberTable)
    .where(inArray(TeamMemberTable.teamId, teamIds))
    .groupBy(TeamMemberTable.teamId)
  return new Map(rows.map((row) => [row.teamId, Number(row.members)]))
}

/** Everyone's settings and every team's, with each team's name and size, teams by name. */
export async function listAgentPermissionPolicies(organizationId: OrganizationId): Promise<{
  everyone: AgentPermissionPolicyRecord
  teams: AgentPermissionTeamPolicyRecord[]
}> {
  const [policies, teams] = await Promise.all([
    db.select().from(AgentPermissionPolicyTable).where(eq(AgentPermissionPolicyTable.organizationId, organizationId)),
    db
      .select({ id: TeamTable.id, name: TeamTable.name })
      .from(TeamTable)
      .where(eq(TeamTable.organizationId, organizationId))
      .orderBy(asc(TeamTable.name)),
  ])
  const [settings, memberCounts] = await Promise.all([
    readSettings(db, policies.map((policy) => policy.id)),
    teamMemberCounts(teams.map((team) => team.id)),
  ])
  const everyone = policies.find((policy) => policy.scopeKey === EVERYONE_SCOPE)
  const byTeam = new Map(policies.flatMap((policy) => policy.teamId ? [[policy.teamId, policy] as const] : []))
  return {
    everyone: {
      teamId: null,
      settings: everyone ? settings.get(everyone.id) ?? {} : {},
      updatedAt: everyone?.updatedAt ?? null,
    },
    teams: teams.map((team) => {
      const policy = byTeam.get(team.id)
      return {
        teamId: team.id,
        teamName: team.name,
        memberCount: memberCounts.get(team.id) ?? 0,
        settings: policy ? settings.get(policy.id) ?? {} : {},
        updatedAt: policy?.updatedAt ?? null,
      }
    }),
  }
}

export async function findOrganizationTeam(organizationId: OrganizationId, teamId: TeamId) {
  const [team] = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, teamId)))
    .limit(1)
  if (!team) return null
  return { ...team, memberCount: (await teamMemberCounts([team.id])).get(team.id) ?? 0 }
}

/**
 * Replaces one policy's settings: everyone's (teamId null) or one team's. A
 * permission left out stops applying: for a team it inherits everyone's
 * again, and settings with nothing left remove the policy.
 */
export async function saveAgentPermissionPolicy(input: {
  organizationId: OrganizationId
  teamId: TeamId | null
  settings: AgentPermissionSettings
  updatedByOrgMemberId: MemberId
}): Promise<{ settings: AgentPermissionSettings; updatedAt: Date | null }> {
  const scopeKey = input.teamId ?? EVERYONE_SCOPE
  const now = new Date()
  const settings: AgentPermissionSettings = {}
  const entries = agentPermissionDefinitions.flatMap((definition) => {
    const setting = normalizeAgentPermissionSetting(definition, input.settings[definition.key])
    if (setting) settings[definition.key] = setting
    return setting ? [{ key: definition.key, setting }] : []
  })
  return db.transaction(async (tx) => {
    const scope = and(
      eq(AgentPermissionPolicyTable.organizationId, input.organizationId),
      eq(AgentPermissionPolicyTable.scopeKey, scopeKey),
    )
    const [existing] = await tx.select({ id: AgentPermissionPolicyTable.id }).from(AgentPermissionPolicyTable).where(scope).limit(1)
    if (existing) {
      await tx.delete(AgentPermissionSettingTable).where(eq(AgentPermissionSettingTable.policyId, existing.id))
    }
    if (entries.length === 0) {
      if (existing) await tx.delete(AgentPermissionPolicyTable).where(eq(AgentPermissionPolicyTable.id, existing.id))
      return { settings, updatedAt: null }
    }
    const policyId = existing?.id ?? createDenTypeId("agentPermissionPolicy")
    if (existing) {
      await tx
        .update(AgentPermissionPolicyTable)
        .set({ updatedByOrgMemberId: input.updatedByOrgMemberId, updatedAt: now })
        .where(eq(AgentPermissionPolicyTable.id, existing.id))
    } else {
      await tx.insert(AgentPermissionPolicyTable).values({
        id: policyId,
        organizationId: input.organizationId,
        teamId: input.teamId,
        scopeKey,
        updatedByOrgMemberId: input.updatedByOrgMemberId,
        createdAt: now,
        updatedAt: now,
      })
    }
    await tx.insert(AgentPermissionSettingTable).values(entries.map(({ key, setting }) => ({
      id: createDenTypeId("agentPermissionSetting"),
      organizationId: input.organizationId,
      policyId,
      permissionKey: key,
      decision: setting.decision ?? null,
      allowPatterns: setting.allow ?? [],
      blockPatterns: setting.block ?? [],
      updatedAt: now,
    })))
    return { settings, updatedAt: now }
  })
}

/** Removes a team's policy inside the transaction that deletes the team. */
export async function deleteTeamAgentPermissionPolicy(database: Database, teamId: TeamId): Promise<void> {
  const policies = await database
    .select({ id: AgentPermissionPolicyTable.id })
    .from(AgentPermissionPolicyTable)
    .where(eq(AgentPermissionPolicyTable.teamId, teamId))
  if (policies.length === 0) return
  const ids = policies.map((policy) => policy.id)
  await database.delete(AgentPermissionSettingTable).where(inArray(AgentPermissionSettingTable.policyId, ids))
  await database.delete(AgentPermissionPolicyTable).where(inArray(AgentPermissionPolicyTable.id, ids))
}

/** Removes every agent permission of an organization inside the transaction that deletes it. */
export async function deleteOrganizationAgentPermissions(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(AgentPermissionSettingTable).where(eq(AgentPermissionSettingTable.organizationId, organizationId))
  await database.delete(AgentPermissionPolicyTable).where(eq(AgentPermissionPolicyTable.organizationId, organizationId))
}

/** The rules a member's apps enforce: everyone's settings, then the member's teams', by team name. */
export async function readAgentPermissionRulesForMember(input: {
  organizationId: OrganizationId
  orgMemberId: MemberId
}): Promise<AgentPermissionRule[]> {
  const teams = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.orgMemberId)))
    .orderBy(asc(TeamTable.name))
  const teamIds = teams.map((team) => team.id)
  const policies = await db
    .select({ id: AgentPermissionPolicyTable.id, teamId: AgentPermissionPolicyTable.teamId, scopeKey: AgentPermissionPolicyTable.scopeKey })
    .from(AgentPermissionPolicyTable)
    .where(and(
      eq(AgentPermissionPolicyTable.organizationId, input.organizationId),
      teamIds.length > 0
        ? or(eq(AgentPermissionPolicyTable.scopeKey, EVERYONE_SCOPE), inArray(AgentPermissionPolicyTable.teamId, teamIds))
        : eq(AgentPermissionPolicyTable.scopeKey, EVERYONE_SCOPE),
    ))
  if (policies.length === 0) return []
  const settings = await readSettings(db, policies.map((policy) => policy.id))
  const everyone = policies.find((policy) => policy.scopeKey === EVERYONE_SCOPE)
  return resolveAgentPermissionRules({
    everyone: everyone ? { source: AGENT_PERMISSION_EVERYONE, settings: settings.get(everyone.id) ?? {} } : null,
    teams: teams.flatMap((team) => {
      const policy = policies.find((entry) => entry.teamId === team.id)
      return policy ? [{ source: team.name, settings: settings.get(policy.id) ?? {} }] : []
    }),
  })
}
