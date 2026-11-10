import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, TeamMemberTable, TeamTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotModel } from "@openwork/types/den/workbot-settings"
import {
  applyWorkbotTeamSettingsWrite,
  countWorkbotTeamConflicts,
  readWorkbotEnabled,
  readWorkbotTeamSettings,
  resolveWorkbotTeamSettings,
  type WorkbotSettingSource,
  type WorkbotTeamSettingsView,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings"
import { cache } from "../cache.js"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"

/**
 * A team's own Workbot default model and name (the `workbotTeamSettings` feature), on top of the organization's
 * (packages/types/src/den/workbot-team-settings.ts). Admins set them in Den › Members › Teams › a team › Workbot;
 * every reader that acts for one member asks `resolveMemberWorkbotSettings`, so a team's value follows its members
 * to Workbot, the Slack assistant, their cloud Automations and Your agent. With the feature off the rows are kept
 * and ignored.
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
 * name it gave the app in Settings › Brand (null when it set none), which Workbot goes by, and whether Workbot
 * is on for its members (on unless an admin turned it off).
 */
export function organizationWorkbotSettings(metadata: unknown): { model: string | null; name: string | null; enabled: boolean } {
  const brand = parseMetadata(metadata).brandAppName
  return {
    model: readWorkbotModel(metadata),
    name: typeof brand === "string" && brand.trim() ? brand.trim() : null,
    enabled: readWorkbotEnabled(metadata),
  }
}

/** The organization's values and every team's overrides, teams by name, with each team's size and conflicts. */
export async function listWorkbotTeamSettings(organizationId: OrganizationId): Promise<Omit<WorkbotTeamSettingsView, "canEdit">> {
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
  const byTeam = new Map(rows.map((row) => [row.teamId, readWorkbotTeamSettings(row.settings)] as const))
  const teamSettings = teams.map((team) => ({ teamId: team.id, settings: byTeam.get(team.id) ?? {} }))
  const conflicts = countWorkbotTeamConflicts({ teams: teamSettings, memberships })
  return {
    organization: organizationWorkbotSettings(organizations[0]?.metadata),
    teams: teams.map((team) => {
      const settings = byTeam.get(team.id) ?? {}
      return {
        teamId: team.id,
        teamName: team.name,
        memberCount: memberships.filter((membership) => membership.teamId === team.id).length,
        model: settings.model !== undefined ? { inherit: false as const, value: settings.model } : { inherit: true as const },
        name: settings.name !== undefined ? { inherit: false as const, value: settings.name } : { inherit: true as const },
        enabled: settings.enabled !== undefined ? { inherit: false as const, value: settings.enabled } : { inherit: true as const },
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
      id: createDenTypeId("workbotTeamSetting"),
      organizationId: input.organizationId,
      teamId: input.teamId,
      settings,
      updatedByOrgMemberId: input.updatedByOrgMemberId,
      createdAt: now,
      updatedAt: now,
    })
  })
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
  modelFrom: WorkbotSettingSource
  nameFrom: WorkbotSettingSource
  enabledFrom: WorkbotSettingSource
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
}

/**
 * The Workbot default model, name and on/off switch that apply to one member: their teams' when those override
 * the organization's and agree, otherwise the organization's (see resolveWorkbotTeamSettings). It selects values
 * only; it never grants model access.
 *
 * With the feature off this is the organization's model and name, Workbot is on for everyone (a saved switch is
 * kept but ignored), and the team rows are not read. A member who cannot be found, or a failed team read, gives
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
  }
  try {
    // The switch belongs to the feature: off, nobody loses Workbot to a value saved while it was on.
    if (!(input.featureOn ?? await deps.featureOn(organizationId, input.userId ?? null))) return { ...fromOrganization, enabled: true }
    const memberId = input.memberId ?? (input.userId ? await deps.memberId(organizationId, input.userId) : null)
    if (!memberId) return fromOrganization
    const teams = await deps.teams({ organizationId, memberId: normalizeDenTypeId("member", memberId) })
    if (teams.length === 0) return fromOrganization
    const rows = await deps.rows(organizationId, teams.map((team) => team.id))
    if (rows.length === 0) return fromOrganization
    const resolved = resolveWorkbotTeamSettings({
      organization,
      teams: teams.map((team) => ({ name: team.name, settings: readWorkbotTeamSettings(rows.find((row) => row.teamId === team.id)?.settings) })),
    })
    return {
      model: resolved.model.value,
      name: resolved.name.value,
      enabled: resolved.enabled.value,
      modelFrom: resolved.model.from,
      nameFrom: resolved.name.from,
      enabledFrom: resolved.enabled.from,
    }
  } catch (error) {
    console.warn("[workbot-team-settings] could not resolve a member's team settings", error instanceof Error ? error.message : error)
    return fromOrganization
  }
}
