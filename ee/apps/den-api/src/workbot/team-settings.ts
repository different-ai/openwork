import { and, asc, eq, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, TeamMemberTable, TeamTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  type AgentTemplateContent,
  type WorkbotProactiveSettings,
  type WorkbotProactiveSettingsInput,
} from "@openwork/types/den/workbot-proactive"
import { readWorkbotModel } from "@openwork/types/den/workbot-settings"
import {
  applyWorkbotTeamSettingsWrite,
  countWorkbotTeamConflicts,
  readWorkbotEnabled,
  readWorkbotTeamAgent,
  readWorkbotTeamSettings,
  resolveWorkbotTeamAgent,
  resolveWorkbotTeamSettings,
  type WorkbotSettingSource,
  type WorkbotTeamAgent,
  type WorkbotTeamStoredSettings,
  type WorkbotTeamSettingsView,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { listTeamsForMember } from "../member-teams.js"
import { readAgentTemplate, type AgentTemplateVersion } from "../workbot-proactive/template.js"

type OrganizationId = DenTypeId<"organization">
type TeamId = DenTypeId<"team">
type MemberId = DenTypeId<"member">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== "string") return isRecord(metadata) ? metadata : {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function organizationWorkbotSettings(metadata: unknown): { model: string | null; name: string | null; enabled: boolean } {
  const brand = parseMetadata(metadata).brandAppName
  return {
    model: readWorkbotModel(metadata),
    name: typeof brand === "string" && brand.trim() ? brand.trim() : null,
    enabled: readWorkbotEnabled(metadata),
  }
}

function withoutAgent<T extends { agent?: WorkbotTeamAgent }>(settings: T): Omit<T, "agent"> {
  const { agent: _hidden, ...rest } = settings
  return rest
}

export async function listWorkbotTeamSettings(organizationId: OrganizationId, options: { agents: boolean }): Promise<Omit<WorkbotTeamSettingsView, "canEdit">> {
  const [organizations, rows, teams] = await Promise.all([
    db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1),
    db.$primary
      .select({ teamId: WorkbotTeamSettingTable.teamId, settings: WorkbotTeamSettingTable.settings })
      .from(WorkbotTeamSettingTable)
      .where(eq(WorkbotTeamSettingTable.organizationId, organizationId)),
    db.$primary.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable).where(eq(TeamTable.organizationId, organizationId)).orderBy(asc(TeamTable.name)),
  ])
  const membershipRows = teams.length > 0
    ? await db.$primary
      .select({ teamId: TeamMemberTable.teamId, memberId: TeamMemberTable.orgMembershipId })
      .from(TeamMemberTable)
      .where(inArray(TeamMemberTable.teamId, teams.map((team) => team.id)))
    : []
  const memberships = membershipRows.flatMap((row) => row.memberId ? [{ teamId: row.teamId, memberId: row.memberId }] : [])
  const shown = (settings: WorkbotTeamStoredSettings): WorkbotTeamStoredSettings => options.agents ? settings : withoutAgent(settings)
  const byTeam = new Map(rows.map((row) => [row.teamId, shown(readWorkbotTeamSettings(row.settings))] as const))
  const teamSettings = teams.map((team) => ({ teamId: team.id, settings: byTeam.get(team.id) ?? {} }))
  const conflicts = countWorkbotTeamConflicts({ teams: teamSettings, memberships })
  const organization = organizationWorkbotSettings(organizations[0]?.metadata)
  const everyones = readWorkbotProactiveSettings(organizations[0]?.metadata)
  const agentEnabled = options.agents ? everyones.enabled : false
  const agentCalendar = everyones.sources.calendar
  return {
    organization: { ...organization, ...(options.agents ? { agentEnabled, agentCalendar } : {}) },
    teams: teams.map((team) => {
      const settings = byTeam.get(team.id) ?? {}
      return {
        teamId: team.id,
        teamName: team.name,
        memberCount: memberships.filter((membership) => membership.teamId === team.id).length,
        model: settings.model !== undefined ? { inherit: false as const, value: settings.model } : { inherit: true as const },
        name: settings.name !== undefined ? { inherit: false as const, value: settings.name } : { inherit: true as const },
        enabled: settings.enabled !== undefined ? { inherit: false as const, value: settings.enabled } : { inherit: true as const },
        ...(options.agents ? { agent: {
          inherit: !settings.agent,
          enabled: settings.agent ? settings.agent.settings.enabled : agentEnabled,
          calendar: settings.agent ? settings.agent.settings.sources.calendar : agentCalendar,
        } } : {}),
        conflictingMemberCount: conflicts.get(team.id) ?? 0,
      }
    }),
  }
}

export async function saveWorkbotTeamSettings(input: {
  organizationId: OrganizationId
  teamId: TeamId
  change: WorkbotTeamSettingsWrite
  updatedByOrgMemberId: MemberId
  id?: DenTypeId<"workbotTeamSetting">
}): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    const scope = and(eq(WorkbotTeamSettingTable.organizationId, input.organizationId), eq(WorkbotTeamSettingTable.teamId, input.teamId))
    const [existing] = await tx
      .select({ id: WorkbotTeamSettingTable.id, settings: WorkbotTeamSettingTable.settings })
      .from(WorkbotTeamSettingTable)
      .where(scope)
      .limit(1)
      .for("update")
    const settings = applyWorkbotTeamSettingsWrite(isRecord(existing?.settings) ? existing.settings : {}, input.change)
    if (Object.keys(settings).length === 0) {
      if (existing) await tx.delete(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.id, existing.id))
      return
    }
    if (existing) {
      await tx
        .update(WorkbotTeamSettingTable)
        .set({ settings, updatedByOrgMemberId: input.updatedByOrgMemberId, updatedAt: now })
        .where(eq(WorkbotTeamSettingTable.id, existing.id))
      return
    }
    await tx.insert(WorkbotTeamSettingTable).values({
      id: input.id ?? createDenTypeId("workbotTeamSetting"),
      organizationId: input.organizationId,
      teamId: input.teamId,
      settings,
      updatedByOrgMemberId: input.updatedByOrgMemberId,
      createdAt: now,
      updatedAt: now,
    })
  })
}

function teamAgentTemplate(agent: WorkbotTeamAgent): AgentTemplateVersion {
  const { versionId, ...template } = agent.template
  return { ...template, versionId: isDenTypeId("configObjectVersion", versionId) ? versionId : null }
}

export type AgentPolicy = { settings: WorkbotProactiveSettings; template: AgentTemplateVersion }

export async function readEveryoneAgentPolicy(organizationId: OrganizationId): Promise<AgentPolicy> {
  const [organization] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  return { settings: readWorkbotProactiveSettings(organization?.metadata), template: await readAgentTemplate(organizationId, db.$primary) }
}

export async function readTeamAgentPolicy(organizationId: OrganizationId, teamId: TeamId): Promise<AgentPolicy | null> {
  const [row] = await db.$primary
    .select({ settings: WorkbotTeamSettingTable.settings })
    .from(WorkbotTeamSettingTable)
    .where(and(eq(WorkbotTeamSettingTable.organizationId, organizationId), eq(WorkbotTeamSettingTable.teamId, teamId)))
    .limit(1)
  const agent = readWorkbotTeamSettings(row?.settings).agent
  return agent ? { settings: agent.settings, template: teamAgentTemplate(agent) } : null
}

export async function saveTeamAgentPolicy(input: {
  organizationId: OrganizationId
  teamId: TeamId
  change: WorkbotProactiveSettingsInput
  everyone: { settings: WorkbotProactiveSettings; template: AgentTemplateContent }
  updatedByOrgMemberId: MemberId
}): Promise<AgentPolicy | null> {
  const now = new Date()
  return db.transaction(async (tx) => {
    const scope = and(eq(WorkbotTeamSettingTable.organizationId, input.organizationId), eq(WorkbotTeamSettingTable.teamId, input.teamId))
    const [existing] = await tx
      .select({ id: WorkbotTeamSettingTable.id, settings: WorkbotTeamSettingTable.settings })
      .from(WorkbotTeamSettingTable)
      .where(scope)
      .limit(1)
      .for("update")
    const stored = isRecord(existing?.settings) ? existing.settings : {}
    const own = readWorkbotTeamAgent(stored.agent)
    const settings = mergeWorkbotProactiveSettings(own?.settings ?? input.everyone.settings, input.change)
    if (!settings) return null
    const { responsibilities, instructions } = own?.template ?? input.everyone.template
    const edited = mergeAgentTemplate({ responsibilities, instructions }, input.change)
    const template = own && !edited
      ? own.template
      : { ...(edited ?? { responsibilities, instructions }), version: (own?.template.version ?? 0) + 1, versionId: createDenTypeId("configObjectVersion") }
    const agent: WorkbotTeamAgent = { settings, template }
    const next = { ...stored, agent }
    if (existing) {
      await tx
        .update(WorkbotTeamSettingTable)
        .set({ settings: next, updatedByOrgMemberId: input.updatedByOrgMemberId, updatedAt: now })
        .where(eq(WorkbotTeamSettingTable.id, existing.id))
    } else {
      await tx.insert(WorkbotTeamSettingTable).values({
        id: createDenTypeId("workbotTeamSetting"),
        organizationId: input.organizationId,
        teamId: input.teamId,
        settings: next,
        updatedByOrgMemberId: input.updatedByOrgMemberId,
        createdAt: now,
        updatedAt: now,
      })
    }
    return { settings, template: teamAgentTemplate(agent) }
  })
}

export async function listOrganizationsWithTeamAgents(): Promise<OrganizationId[]> {
  const rows = await db
    .selectDistinct({ organizationId: WorkbotTeamSettingTable.organizationId })
    .from(WorkbotTeamSettingTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${WorkbotTeamSettingTable.settings}, '$.agent.settings.enabled')) = 'true'`)
  return rows.map((row) => row.organizationId)
}

export async function deleteTeamWorkbotSettings(database: Database, teamId: TeamId): Promise<void> {
  await database.delete(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.teamId, teamId))
}

export async function deleteOrganizationWorkbotTeamSettings(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.organizationId, organizationId))
}

export type MemberWorkbotSettings = {
  model: string | null
  name: string | null
  enabled: boolean
  modelFrom: WorkbotSettingSource
  nameFrom: WorkbotSettingSource
  enabledFrom: WorkbotSettingSource
  agent: WorkbotTeamAgent | null
  agentFrom: WorkbotSettingSource
}

export type MemberWorkbotSettingsInput = {
  organizationId: string
  memberId?: string | null
  userId?: string | null
  organization?: { metadata: unknown }
}

export type MemberWorkbotSettingsDeps = {
  metadata: (organizationId: OrganizationId) => Promise<unknown>
  memberId: (organizationId: OrganizationId, userId: string) => Promise<string | null>
  teams: (member: { organizationId: OrganizationId; memberId: MemberId }) => Promise<ReadonlyArray<{ id: string; name: string }>>
  rows: (organizationId: OrganizationId, teamIds: readonly string[]) => Promise<ReadonlyArray<{ teamId: string; settings: unknown }>>
  template: (organizationId: OrganizationId) => Promise<AgentTemplateVersion>
}

const liveDeps: MemberWorkbotSettingsDeps = {
  metadata: async (organizationId) => {
    const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
    return organization?.metadata
  },
  memberId: async (organizationId, userId) => (await cache.org.membership({ organizationId, userId: normalizeDenTypeId("user", userId) }))?.id ?? null,
  teams: listTeamsForMember,
  rows: (organizationId, teamIds) => db
    .select({ teamId: WorkbotTeamSettingTable.teamId, settings: WorkbotTeamSettingTable.settings })
    .from(WorkbotTeamSettingTable)
    .where(and(
      eq(WorkbotTeamSettingTable.organizationId, organizationId),
      inArray(WorkbotTeamSettingTable.teamId, teamIds.map((teamId) => normalizeDenTypeId("team", teamId))),
    )),
  template: (organizationId) => readAgentTemplate(organizationId),
}

type MemberTeams = { teams: ReadonlyArray<{ name: string; settings: WorkbotTeamStoredSettings }> }

async function readMemberTeams(organizationId: OrganizationId, input: MemberWorkbotSettingsInput, deps: MemberWorkbotSettingsDeps): Promise<MemberTeams> {
  const memberId = input.memberId ?? (input.userId ? await deps.memberId(organizationId, input.userId) : null)
  if (!memberId) return { teams: [] }
  const teams = await deps.teams({ organizationId, memberId: normalizeDenTypeId("member", memberId) })
  if (teams.length === 0) return { teams: [] }
  const rows = await deps.rows(organizationId, teams.map((team) => team.id))
  if (rows.length === 0) return { teams: [] }
  return { teams: teams.map((team) => ({ name: team.name, settings: readWorkbotTeamSettings(rows.find((row) => row.teamId === team.id)?.settings) })) }
}

export async function resolveMemberWorkbotSettings(
  input: MemberWorkbotSettingsInput,
  suppliedDeps: Partial<MemberWorkbotSettingsDeps> = {},
): Promise<MemberWorkbotSettings> {
  const deps = { ...liveDeps, ...suppliedDeps }
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const organization = organizationWorkbotSettings(input.organization ? input.organization.metadata : await deps.metadata(organizationId))
  const fromOrganization: MemberWorkbotSettings = {
    ...organization,
    modelFrom: { kind: "organization", teamConflict: false },
    nameFrom: { kind: "organization", teamConflict: false },
    enabledFrom: { kind: "organization", teamConflict: false },
    agent: null,
    agentFrom: { kind: "organization", teamConflict: false },
  }
  try {
    const { teams } = await readMemberTeams(organizationId, input, deps)
    if (teams.length === 0) return fromOrganization
    const resolved = resolveWorkbotTeamSettings({ organization, teams })
    return {
      model: resolved.model.value,
      name: resolved.name.value,
      enabled: resolved.enabled.value,
      modelFrom: resolved.model.from,
      nameFrom: resolved.name.from,
      enabledFrom: resolved.enabled.from,
      agent: resolved.agent.value,
      agentFrom: resolved.agent.from,
    }
  } catch (error) {
    console.warn("[workbot-team-settings] could not resolve a member's team settings", error instanceof Error ? error.message : error)
    return fromOrganization
  }
}

export type MemberAgentPolicy = AgentPolicy & {
  from: WorkbotSettingSource
}

export type MemberTeamAgent = Pick<MemberWorkbotSettings, "agent" | "agentFrom">

export async function resolveMemberTeamAgent(input: MemberWorkbotSettingsInput, suppliedDeps: Partial<MemberWorkbotSettingsDeps> = {}): Promise<MemberTeamAgent> {
  const deps = { ...liveDeps, ...suppliedDeps }
  try {
    const { teams } = await readMemberTeams(normalizeDenTypeId("organization", input.organizationId), input, deps)
    const resolved = resolveWorkbotTeamAgent(teams)
    return { agent: resolved.value, agentFrom: resolved.from }
  } catch (error) {
    console.warn("[workbot-team-settings] could not resolve a member's team agent policy", error instanceof Error ? error.message : error)
    return { agent: null, agentFrom: { kind: "organization", teamConflict: false } }
  }
}

export function teamAgentPolicy(team: MemberTeamAgent): MemberAgentPolicy | null {
  return team.agent ? { settings: team.agent.settings, template: teamAgentTemplate(team.agent), from: team.agentFrom } : null
}

export function memberAgentSettings(team: MemberTeamAgent, metadata: unknown): WorkbotProactiveSettings {
  return team.agent?.settings ?? readWorkbotProactiveSettings(metadata)
}

export async function resolveMemberAgentPolicy(
  input: MemberWorkbotSettingsInput & { workbot?: MemberTeamAgent },
  suppliedDeps: Partial<MemberWorkbotSettingsDeps> = {},
): Promise<MemberAgentPolicy> {
  const deps = { ...liveDeps, ...suppliedDeps }
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const team = input.workbot ?? await resolveMemberTeamAgent(input, deps)
  const own = teamAgentPolicy(team)
  if (own) return own
  return {
    settings: readWorkbotProactiveSettings(input.organization ? input.organization.metadata : await deps.metadata(organizationId)),
    template: await deps.template(organizationId),
    from: team.agentFrom,
  }
}
