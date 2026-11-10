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
import { readWorkbotMaxSteps, readWorkbotModel } from "@openwork/types/den/workbot-settings"
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
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { readAgentTemplate, type AgentTemplateVersion } from "../workbot-proactive/template.js"

/**
 * A team's own Workbot default model and name (the `workbotTeamSettings` feature), on top of the organization's
 * (packages/types/src/den/workbot-team-settings.ts). Admins set them in Den › Members › Teams › a team › Workbot;
 * every reader that acts for one member asks `resolveMemberWorkbotSettings`, so a team's value follows its members
 * to Workbot, the Slack assistant, their cloud Automations and Your agent. With the feature off the rows are kept
 * and ignored. A team's step limit also needs `workbotStepLimit`: without it the value is kept, hidden from
 * admins and not counted in conflicts.
 *
 * A team can also have its own policy for its members' agents (`agent`, with `workbotProactive`): the whole of the
 * organization's policy and its "Your agent" template, kept together in the team's row. Every reader that acts
 * for one member asks `resolveMemberAgentPolicy`; readers that only know the organization keep its policy.
 */

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

/**
 * The organization's values a team can override: its default model (null is the deployment's default), the
 * name it gave the app in Settings › Brand (null when it set none), which Workbot goes by, whether Workbot
 * is on for its members (on unless an admin turned it off), and its step limit (null is the deployment's default).
 */
export function organizationWorkbotSettings(metadata: unknown): { model: string | null; name: string | null; enabled: boolean; maxSteps: number | null } {
  const brand = parseMetadata(metadata).brandAppName
  return {
    model: readWorkbotModel(metadata),
    name: typeof brand === "string" && brand.trim() ? brand.trim() : null,
    enabled: readWorkbotEnabled(metadata),
    maxSteps: readWorkbotMaxSteps(metadata),
  }
}

function withoutMaxSteps<T extends { maxSteps?: number | null }>(settings: T): Omit<T, "maxSteps"> {
  const { maxSteps: _hidden, ...rest } = settings
  return rest
}

function withoutAgent<T extends { agent?: WorkbotTeamAgent }>(settings: T): Omit<T, "agent"> {
  const { agent: _hidden, ...rest } = settings
  return rest
}

/**
 * The organization's values and every team's overrides, teams by name, with each team's size and conflicts.
 * `stepLimit` is whether `workbotStepLimit` is on: off, the step limit is left out and its conflicts don't count.
 * `agents` is the same for members' agents (`workbotProactive` on a deployment with Workbot).
 */
export async function listWorkbotTeamSettings(organizationId: OrganizationId, options: { stepLimit: boolean; agents: boolean }): Promise<Omit<WorkbotTeamSettingsView, "canEdit">> {
  // Primary: every save answers with this view of the row it just wrote. Admin-only and rare.
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
  const shown = (settings: WorkbotTeamStoredSettings): WorkbotTeamStoredSettings => {
    const limited = options.stepLimit ? settings : withoutMaxSteps(settings)
    return options.agents ? limited : withoutAgent(limited)
  }
  const byTeam = new Map(rows.map((row) => [row.teamId, shown(readWorkbotTeamSettings(row.settings))] as const))
  const teamSettings = teams.map((team) => ({ teamId: team.id, settings: byTeam.get(team.id) ?? {} }))
  const conflicts = countWorkbotTeamConflicts({ teams: teamSettings, memberships })
  const organization = organizationWorkbotSettings(organizations[0]?.metadata)
  const agentEnabled = options.agents ? readWorkbotProactiveSettings(organizations[0]?.metadata).enabled : false
  return {
    organization: { ...(options.stepLimit ? organization : withoutMaxSteps(organization)), ...(options.agents ? { agentEnabled } : {}) },
    teams: teams.map((team) => {
      const settings = byTeam.get(team.id) ?? {}
      return {
        teamId: team.id,
        teamName: team.name,
        memberCount: memberships.filter((membership) => membership.teamId === team.id).length,
        model: settings.model !== undefined ? { inherit: false as const, value: settings.model } : { inherit: true as const },
        name: settings.name !== undefined ? { inherit: false as const, value: settings.name } : { inherit: true as const },
        enabled: settings.enabled !== undefined ? { inherit: false as const, value: settings.enabled } : { inherit: true as const },
        ...(options.stepLimit ? { maxSteps: settings.maxSteps !== undefined ? { inherit: false as const, value: settings.maxSteps } : { inherit: true as const } } : {}),
        ...(options.agents ? { agent: { inherit: !settings.agent, enabled: settings.agent ? settings.agent.settings.enabled : agentEnabled } } : {}),
        conflictingMemberCount: conflicts.get(team.id) ?? 0,
      }
    }),
  }
}

/**
 * Applies one change to a team's settings: each setting in it becomes the team's own value or goes back to the
 * organization's; settings left out are kept. A team left with no override has no row.
 */
export async function saveWorkbotTeamSettings(input: {
  organizationId: OrganizationId
  teamId: TeamId
  change: WorkbotTeamSettingsWrite
  updatedByOrgMemberId: MemberId
  /** The new row's id when the team has none yet (a config import reuses the source's); otherwise a new one. */
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

/** A team's stored template as the version a member's agent records having run. */
function teamAgentTemplate(agent: WorkbotTeamAgent): AgentTemplateVersion {
  const { versionId, ...template } = agent.template
  return { ...template, versionId: isDenTypeId("configObjectVersion", versionId) ? versionId : null }
}

/** A policy for members' agents with its template: the organization's, or one team's own. */
export type AgentPolicy = { settings: WorkbotProactiveSettings; template: AgentTemplateVersion }

/** The organization's policy and template now: what a team without its own follows, and what its first save copies. */
export async function readEveryoneAgentPolicy(organizationId: OrganizationId): Promise<AgentPolicy> {
  // Primary: a team's first save starts from these, possibly right after an admin changed them.
  const [organization] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  return { settings: readWorkbotProactiveSettings(organization?.metadata), template: await readAgentTemplate(organizationId, db.$primary) }
}

/** A team's own policy for its members' agents; null when it follows the organization's. */
export async function readTeamAgentPolicy(organizationId: OrganizationId, teamId: TeamId): Promise<AgentPolicy | null> {
  // Primary: the admin page reads back what it just saved.
  const [row] = await db.$primary
    .select({ settings: WorkbotTeamSettingTable.settings })
    .from(WorkbotTeamSettingTable)
    .where(and(eq(WorkbotTeamSettingTable.organizationId, organizationId), eq(WorkbotTeamSettingTable.teamId, teamId)))
    .limit(1)
  const agent = readWorkbotTeamSettings(row?.settings).agent
  return agent ? { settings: agent.settings, template: teamAgentTemplate(agent) } : null
}

/**
 * Applies an admin's change to a team's policy for its members' agents, merged like the organization's. A team
 * that followed the organization starts from `everyone` (the organization's policy and template now), and this
 * save makes the copy its own. Null when the result is invalid (a workday that ends before it starts); nothing
 * is saved then.
 *
 * The template lives in the row with the policy, so the two are saved and removed together. Each save that
 * changes the template adds one to its version and names it with a new id, as the organization's versions do.
 */
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

/**
 * Organizations where at least one team turned its members' agents on, for the agents' discovery: one query over
 * the team rows. The caller checks each organization's features; with `workbotTeamSettings` off they are ignored.
 */
export async function listOrganizationsWithTeamAgents(): Promise<OrganizationId[]> {
  const rows = await db
    .selectDistinct({ organizationId: WorkbotTeamSettingTable.organizationId })
    .from(WorkbotTeamSettingTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${WorkbotTeamSettingTable.settings}, '$.agent.settings.enabled')) = 'true'`)
  return rows.map((row) => row.organizationId)
}

/** Removes a team's settings inside the transaction that deletes the team. */
export async function deleteTeamWorkbotSettings(database: Database, teamId: TeamId): Promise<void> {
  await database.delete(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.teamId, teamId))
}

/** Removes every team's settings of an organization inside the transaction that deletes it. */
export async function deleteOrganizationWorkbotTeamSettings(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.organizationId, organizationId))
}

/** One member's effective Workbot settings and where each came from. */
export type MemberWorkbotSettings = {
  /** The saved default model; null is the deployment's default model. */
  model: string | null
  /** The name given to Workbot; null when neither the organization nor the member's teams set one. */
  name: string | null
  /** Whether Workbot (its chat app and Your agent) is on for the member. Always the organization's while the feature is off. */
  enabled: boolean
  /** Model calls per request: 0 is no limit, null the deployment's default. The caller checks `workbotStepLimit`. */
  maxSteps: number | null
  modelFrom: WorkbotSettingSource
  nameFrom: WorkbotSettingSource
  enabledFrom: WorkbotSettingSource
  maxStepsFrom: WorkbotSettingSource
  /** The member's teams' own policy for members' agents; null is the organization's (`resolveMemberAgentPolicy`). */
  agent: WorkbotTeamAgent | null
  agentFrom: WorkbotSettingSource
}

export type MemberWorkbotSettingsInput = {
  organizationId: string
  /** The member, when the caller has it; otherwise found from the user. With neither, the organization's values. */
  memberId?: string | null
  userId?: string | null
  /** The organization's row, when the caller already read it. */
  organization?: { metadata: unknown }
  /** Whether `workbotTeamSettings` is on, when the caller already read the organization's features. */
  featureOn?: boolean
}

/** The reads behind one resolution; injectable so tests can run without a database. */
export type MemberWorkbotSettingsDeps = {
  metadata: (organizationId: OrganizationId) => Promise<unknown>
  featureOn: (organizationId: OrganizationId, userId: string | null) => Promise<boolean>
  memberId: (organizationId: OrganizationId, userId: string) => Promise<string | null>
  teams: (member: { organizationId: OrganizationId; memberId: MemberId }) => Promise<ReadonlyArray<{ id: string; name: string }>>
  rows: (organizationId: OrganizationId, teamIds: readonly string[]) => Promise<ReadonlyArray<{ teamId: string; settings: unknown }>>
  /** The organization's "Your agent" template, read only for a member who follows the organization's policy. */
  template: (organizationId: OrganizationId) => Promise<AgentTemplateVersion>
}

const liveDeps: MemberWorkbotSettingsDeps = {
  // Read fresh, so an admin's change applies to the next turn.
  metadata: async (organizationId) => {
    const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
    return organization?.metadata
  },
  featureOn: (organizationId, userId) => organizationFeatureEnabled(organizationId, "workbotTeamSettings", userId ? { userId } : {}),
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

type MemberTeams = { featureOn: boolean; teams: ReadonlyArray<{ name: string; settings: WorkbotTeamStoredSettings }> }

/**
 * The member's teams with what each overrides: the one read every resolution here shares. No teams when the
 * feature is off (nothing is read then), the member cannot be found, or none of their teams has a row.
 */
async function readMemberTeams(organizationId: OrganizationId, input: MemberWorkbotSettingsInput, deps: MemberWorkbotSettingsDeps): Promise<MemberTeams> {
  if (!(input.featureOn ?? await deps.featureOn(organizationId, input.userId ?? null))) return { featureOn: false, teams: [] }
  const memberId = input.memberId ?? (input.userId ? await deps.memberId(organizationId, input.userId) : null)
  if (!memberId) return { featureOn: true, teams: [] }
  const teams = await deps.teams({ organizationId, memberId: normalizeDenTypeId("member", memberId) })
  if (teams.length === 0) return { featureOn: true, teams: [] }
  const rows = await deps.rows(organizationId, teams.map((team) => team.id))
  if (rows.length === 0) return { featureOn: true, teams: [] }
  return { featureOn: true, teams: teams.map((team) => ({ name: team.name, settings: readWorkbotTeamSettings(rows.find((row) => row.teamId === team.id)?.settings) })) }
}

/**
 * The Workbot default model, name, on/off switch and step limit that apply to one member: their teams' when those
 * override the organization's and agree, otherwise the organization's (see resolveWorkbotTeamSettings). It selects
 * values only; it never grants model access.
 *
 * With the feature off this is the organization's model, name and step limit, Workbot is on for everyone (a saved
 * switch is kept but ignored), and the team rows are not read. A member who cannot be found, or a failed team read, gives
 * the organization's values: a team setting never breaks a chat.
 */
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
    maxStepsFrom: { kind: "organization", teamConflict: false },
    agent: null,
    agentFrom: { kind: "organization", teamConflict: false },
  }
  try {
    const { featureOn, teams } = await readMemberTeams(organizationId, input, deps)
    // The switch belongs to the feature: off, nobody loses Workbot to a value saved while it was on.
    if (!featureOn) return { ...fromOrganization, enabled: true }
    if (teams.length === 0) return fromOrganization
    const resolved = resolveWorkbotTeamSettings({ organization, teams })
    return {
      model: resolved.model.value,
      name: resolved.name.value,
      enabled: resolved.enabled.value,
      maxSteps: resolved.maxSteps.value,
      modelFrom: resolved.model.from,
      nameFrom: resolved.name.from,
      enabledFrom: resolved.enabled.from,
      maxStepsFrom: resolved.maxSteps.from,
      agent: resolved.agent.value,
      agentFrom: resolved.agent.from,
    }
  } catch (error) {
    console.warn("[workbot-team-settings] could not resolve a member's team settings", error instanceof Error ? error.message : error)
    return fromOrganization
  }
}

/** The policy for one member's agent, with its template and whose it is. */
export type MemberAgentPolicy = AgentPolicy & {
  /** The teams whose own policy this is, or the organization (also when the member's teams hold different ones). */
  from: WorkbotSettingSource
}

/** What a member's teams say about their agent: part of `MemberWorkbotSettings`, or read on its own. */
export type MemberTeamAgent = Pick<MemberWorkbotSettings, "agent" | "agentFrom">

/**
 * The member's teams' own policy for their agent, without reading the organization's: null agent when the feature
 * is off (nothing is read), no team of theirs has its own, their teams differ, or a read fails. Never throws.
 */
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

/** A team policy as the agent runs it; null when the member follows the organization's. */
export function teamAgentPolicy(team: MemberTeamAgent): MemberAgentPolicy | null {
  return team.agent ? { settings: team.agent.settings, template: teamAgentTemplate(team.agent), from: team.agentFrom } : null
}

/** The policy alone, for a caller that holds the member's Workbot settings and the organization: nothing is read. */
export function memberAgentSettings(team: MemberTeamAgent, metadata: unknown): WorkbotProactiveSettings {
  return team.agent?.settings ?? readWorkbotProactiveSettings(metadata)
}

/**
 * The policy and "Your agent" template one member's agent follows: their teams' own when they have one and agree
 * (policy, sources, brief and template together), otherwise the organization's. With `workbotTeamSettings` off
 * this is the organization's and no team is read; so is a member whose teams differ or cannot be read.
 *
 * `workbot` is the member's settings when the caller already resolved them, so their teams are read once.
 */
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
