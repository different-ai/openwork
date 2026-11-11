import type { AutomationListItem } from "@openwork/automations"
import { automationRevisionDigest } from "@openwork/automations"
import type {
  AutomationAccess,
  AutomationAccessRole,
  AutomationAction,
  AutomationShareAccess,
  AutomationSharing,
  AutomationTeamShare,
} from "@openwork/types/automations"
import { and, desc, eq, inArray, lt, ne } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRevisionTable,
  AutomationRunTable,
  AutomationTable,
  AutomationTeamShareTable,
  MemberTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { listTeamsForMember } from "../member-teams.js"
import type { TeamMutationTransaction } from "../organization-team-roles.js"

/**
 * Team sharing for Automations.
 *
 * An Automation always runs as its owner: the owner's connected accounts,
 * models and computers. A share therefore never changes how it runs, only who
 * else may look at it and operate it. This module is the one place that
 * decides that: it answers "what may this member do with this Automation" and
 * names the owner, and callers then use the owner-scoped service with the
 * owner's scope. Rows grant nothing unless the caller checked that
 * `automationTeamSharing` is on.
 */

type TeamId = typeof TeamTable.$inferSelect.id
type AutomationId = typeof AutomationTable.$inferSelect.id

/** Enough teams for any real Automation, and a bound on what one list item carries. */
export const AUTOMATION_SHARE_TEAM_LIMIT = 20
const ACTIVE_RUN_STATUSES = ["queued", "claimed", "running"] as const

export type AutomationCallerAccess = {
  role: AutomationAccessRole
  ownerMemberId: typeof MemberTable.$inferSelect.id
  automationId: AutomationId
}

type MemberInput = { organizationId: string; memberId: string }

function ids(input: MemberInput) {
  return {
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    memberId: normalizeDenTypeId("member", input.memberId),
  }
}

/** A path parameter that is not an Automation id names nothing the caller can reach. */
function automationIdOrNull(value: string): AutomationId | null {
  try {
    return normalizeDenTypeId("automation", value)
  } catch {
    return null
  }
}

function teamIdOrNull(value: string): TeamId | null {
  try {
    return normalizeDenTypeId("team", value)
  } catch {
    return null
  }
}

function strongest(accesses: readonly AutomationShareAccess[]): AutomationShareAccess | null {
  if (accesses.length === 0) return null
  return accesses.includes("manage") ? "manage" : "view"
}

function mapShare(row: { teamId: string; teamName: string; access: AutomationShareAccess; sharedAt: Date }): AutomationTeamShare {
  return { teamId: row.teamId, teamName: row.teamName, access: row.access, sharedAt: row.sharedAt.getTime() }
}

/** Every share of these Automations whose team still exists in the organization, oldest first. */
async function sharesOf(organizationId: ReturnType<typeof ids>["organizationId"], automationIds: readonly AutomationId[]) {
  if (automationIds.length === 0) return []
  return db.$primary.select({
    automationId: AutomationTeamShareTable.automation_id,
    teamId: AutomationTeamShareTable.team_id,
    teamName: TeamTable.name,
    access: AutomationTeamShareTable.access,
    sharedAt: AutomationTeamShareTable.created_at,
  }).from(AutomationTeamShareTable)
    .innerJoin(TeamTable, and(
      eq(TeamTable.id, AutomationTeamShareTable.team_id),
      eq(TeamTable.organizationId, AutomationTeamShareTable.organization_id),
    ))
    .where(and(
      eq(AutomationTeamShareTable.organization_id, organizationId),
      inArray(AutomationTeamShareTable.automation_id, [...automationIds]),
    ))
    .orderBy(AutomationTeamShareTable.created_at, AutomationTeamShareTable.id)
}

async function memberTeamIds(input: MemberInput): Promise<Set<string>> {
  const teams = await listTeamsForMember(ids(input))
  return new Set(teams.map((team) => team.id))
}

/**
 * What `memberId` may do with one Automation, or null when it is not theirs
 * and no team they are on has it. An archived Automation is its owner's only.
 */
export async function resolveAutomationAccess(input: MemberInput & { automationId: string }): Promise<AutomationCallerAccess | null> {
  const automationId = automationIdOrNull(input.automationId)
  if (!automationId) return null
  const { organizationId, memberId } = ids(input)
  const [automation] = await db.$primary.select({
    ownerMemberId: AutomationTable.owner_member_id,
    state: AutomationTable.state,
  }).from(AutomationTable).where(and(
    eq(AutomationTable.id, automationId),
    eq(AutomationTable.organization_id, organizationId),
  )).limit(1)
  if (!automation) return null
  if (automation.ownerMemberId === memberId) return { role: "owner", ownerMemberId: automation.ownerMemberId, automationId }
  if (automation.state === "archived") return null
  const [shares, teams] = await Promise.all([sharesOf(organizationId, [automationId]), memberTeamIds(input)])
  const access = strongest(shares.filter((share) => teams.has(share.teamId)).map((share) => share.access))
  return access ? { role: access, ownerMemberId: automation.ownerMemberId, automationId } : null
}

/** The same decision for a run, through the Automation it belongs to. */
export async function resolveAutomationRunAccess(input: MemberInput & { runId: string }): Promise<AutomationCallerAccess | null> {
  let runId: typeof AutomationRunTable.$inferSelect.id
  try {
    runId = normalizeDenTypeId("automationRun", input.runId)
  } catch {
    return null
  }
  const [run] = await db.$primary.select({ automationId: AutomationRunTable.automation_id })
    .from(AutomationRunTable).where(eq(AutomationRunTable.id, runId)).limit(1)
  return run ? resolveAutomationAccess({ ...input, automationId: run.automationId }) : null
}

/**
 * The caller's access to each listed Automation, for the `access` field of
 * list items and details. An owner sees every team it is shared with; a
 * teammate sees the teams that give them access. Automations the caller cannot
 * reach are left out.
 */
export async function describeAutomationAccess(input: MemberInput & {
  automations: ReadonlyArray<{ id: string; ownerMemberId: string }>
}): Promise<Map<string, AutomationAccess>> {
  const result = new Map<string, AutomationAccess>()
  if (input.automations.length === 0) return result
  const { organizationId, memberId } = ids(input)
  const automationIds = input.automations.flatMap((automation) => automationIdOrNull(automation.id) ?? [])
  const ownerIds = [...new Set(input.automations.map((automation) => normalizeDenTypeId("member", automation.ownerMemberId)))]
  const [shares, teams, owners] = await Promise.all([
    sharesOf(organizationId, automationIds),
    memberTeamIds(input),
    db.select({ memberId: MemberTable.id, name: AuthUserTable.name }).from(MemberTable)
      .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, ownerIds))),
  ])
  const ownerNames = new Map(owners.map((owner) => [owner.memberId, owner.name?.trim() || null]))
  for (const automation of input.automations) {
    const all = shares.filter((share) => share.automationId === automation.id)
    const owner = { memberId: automation.ownerMemberId, name: ownerNames.get(normalizeDenTypeId("member", automation.ownerMemberId)) ?? null }
    if (automation.ownerMemberId === memberId) {
      result.set(automation.id, { role: "owner", owner, teams: all.map(mapShare) })
      continue
    }
    const mine = all.filter((share) => teams.has(share.teamId))
    const access = strongest(mine.map((share) => share.access))
    if (access) result.set(automation.id, { role: access, owner, teams: mine.map(mapShare) })
  }
  return result
}

/** Adds the caller's `access` to items they can reach; the rest pass through unchanged. */
export async function withAutomationAccess<T extends AutomationListItem>(
  input: MemberInput,
  items: readonly T[],
): Promise<Array<T & { access?: AutomationAccess }>> {
  const access = await describeAutomationAccess({
    ...input,
    automations: items.map((item) => ({ id: item.automation.id, ownerMemberId: item.automation.ownerMemberId })),
  })
  return items.map((item) => {
    const entry = access.get(item.automation.id)
    return entry ? { ...item, access: entry } : { ...item }
  })
}

/**
 * Ids of the Automations other people shared with teams the caller is on,
 * newest first. Archived ones and the caller's own are left out.
 */
export async function listSharedAutomationIds(input: MemberInput & { cursor?: string; limit: number }): Promise<{
  automationIds: string[]
  nextCursor: string | null
}> {
  const { organizationId, memberId } = ids(input)
  const limit = Math.max(1, Math.min(input.limit, 100))
  const cursor = input.cursor ? automationIdOrNull(input.cursor) : null
  if (input.cursor && !cursor) return { automationIds: [], nextCursor: null }
  const rows = await db.selectDistinct({ id: AutomationTable.id }).from(AutomationTeamShareTable)
    .innerJoin(AutomationTable, and(
      eq(AutomationTable.id, AutomationTeamShareTable.automation_id),
      eq(AutomationTable.organization_id, AutomationTeamShareTable.organization_id),
    ))
    .innerJoin(TeamTable, and(
      eq(TeamTable.id, AutomationTeamShareTable.team_id),
      eq(TeamTable.organizationId, AutomationTeamShareTable.organization_id),
    ))
    .innerJoin(TeamMemberTable, and(
      eq(TeamMemberTable.teamId, AutomationTeamShareTable.team_id),
      eq(TeamMemberTable.orgMembershipId, memberId),
    ))
    .where(and(
      eq(AutomationTeamShareTable.organization_id, organizationId),
      ne(AutomationTable.owner_member_id, memberId),
      ne(AutomationTable.state, "archived"),
      ...(cursor ? [lt(AutomationTable.id, cursor)] : []),
    ))
    .orderBy(desc(AutomationTable.id)).limit(limit + 1)
  const selected = rows.slice(0, limit)
  return {
    automationIds: selected.map((row) => row.id),
    nextCursor: rows.length > limit ? selected.at(-1)?.id ?? null : null,
  }
}

async function ownedAutomation(input: MemberInput & { automationId: string }) {
  const automationId = automationIdOrNull(input.automationId)
  if (!automationId) return null
  const { organizationId, memberId } = ids(input)
  const [automation] = await db.$primary.select({ id: AutomationTable.id, state: AutomationTable.state })
    .from(AutomationTable).where(and(
      eq(AutomationTable.id, automationId),
      eq(AutomationTable.organization_id, organizationId),
      eq(AutomationTable.owner_member_id, memberId),
    )).limit(1)
  return automation ? { ...automation, organizationId, memberId } : null
}

/** Who the owner's Automation is shared with and the teams they can share it with; null when it is not theirs. */
export async function readAutomationSharing(input: MemberInput & { automationId: string }): Promise<AutomationSharing | null> {
  const automation = await ownedAutomation(input)
  if (!automation) return null
  const [shares, teams] = await Promise.all([
    sharesOf(automation.organizationId, [automation.id]),
    listTeamsForMember({ organizationId: automation.organizationId, memberId: automation.memberId }),
  ])
  return {
    teams: shares.map(mapShare),
    shareableTeams: teams.map((team) => ({ teamId: team.id, teamName: team.name })),
  }
}

export class AutomationSharingError extends Error {
  constructor(readonly code:
    | "automation_not_found"
    | "automation_share_team_not_allowed"
    | "automation_share_limit_reached"
    | "automation_manage_required"
    | "automation_already_owned"
    | "automation_run_in_progress") {
    super(code)
    this.name = "AutomationSharingError"
  }
}

/**
 * Shares the caller's own Automation with a team they are on, or changes that
 * team's access. Only the owner shares: a share shows teammates what the
 * Automation did with the owner's accounts.
 */
export async function shareAutomationWithTeam(input: MemberInput & {
  automationId: string
  teamId: string
  access: AutomationShareAccess
}): Promise<AutomationSharing> {
  const automation = await ownedAutomation(input)
  if (!automation || automation.state === "archived") throw new AutomationSharingError("automation_not_found")
  const teamId = teamIdOrNull(input.teamId)
  const teams = await listTeamsForMember({ organizationId: automation.organizationId, memberId: automation.memberId })
  if (!teamId || !teams.some((team) => team.id === teamId)) throw new AutomationSharingError("automation_share_team_not_allowed")
  const existing = await sharesOf(automation.organizationId, [automation.id])
  if (!existing.some((share) => share.teamId === teamId) && existing.length >= AUTOMATION_SHARE_TEAM_LIMIT) {
    throw new AutomationSharingError("automation_share_limit_reached")
  }
  await db.insert(AutomationTeamShareTable).values({
    id: createDenTypeId("automationTeamShare"),
    organization_id: automation.organizationId,
    automation_id: automation.id,
    team_id: teamId,
    access: input.access,
    shared_by_member_id: automation.memberId,
  }).onDuplicateKeyUpdate({ set: { access: input.access, shared_by_member_id: automation.memberId } })
  const sharing = await readAutomationSharing(input)
  if (!sharing) throw new AutomationSharingError("automation_not_found")
  return sharing
}

/** Stops sharing with one team. The owner can always do this, including for a team they have since left. */
export async function stopSharingAutomationWithTeam(input: MemberInput & { automationId: string; teamId: string }): Promise<AutomationSharing> {
  const automation = await ownedAutomation(input)
  if (!automation) throw new AutomationSharingError("automation_not_found")
  const teamId = teamIdOrNull(input.teamId)
  if (teamId) {
    await db.delete(AutomationTeamShareTable).where(and(
      eq(AutomationTeamShareTable.automation_id, automation.id),
      eq(AutomationTeamShareTable.team_id, teamId),
    ))
  }
  const sharing = await readAutomationSharing(input)
  if (!sharing) throw new AutomationSharingError("automation_not_found")
  return sharing
}

/**
 * Makes a teammate with manage access the owner. From then on the Automation
 * runs with the new owner's accounts, models and computers, so it is left
 * paused for them to resume, and a workspace pinned on the previous owner's
 * computer is dropped. Refused while a run is in progress: that run belongs to
 * the previous owner's runner. Shares are kept, so the team still sees it.
 */
export async function transferAutomationOwnership(input: {
  organizationId: string
  automationId: string
  fromOwnerMemberId: string
  toMemberId: string
  now: number
}): Promise<void> {
  const automationId = automationIdOrNull(input.automationId)
  if (!automationId) throw new AutomationSharingError("automation_not_found")
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const fromOwnerMemberId = normalizeDenTypeId("member", input.fromOwnerMemberId)
  const toMemberId = normalizeDenTypeId("member", input.toMemberId)
  await db.transaction(async (tx) => {
    const [automation] = await tx.select().from(AutomationTable).where(and(
      eq(AutomationTable.id, automationId),
      eq(AutomationTable.organization_id, organizationId),
      eq(AutomationTable.owner_member_id, fromOwnerMemberId),
    )).limit(1).for("update")
    if (!automation || automation.state === "archived") throw new AutomationSharingError("automation_not_found")
    const [activeRun] = await tx.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(and(
      eq(AutomationRunTable.automation_id, automation.id),
      inArray(AutomationRunTable.status, [...ACTIVE_RUN_STATUSES]),
    )).limit(1)
    if (activeRun) throw new AutomationSharingError("automation_run_in_progress")
    const [current] = await tx.select().from(AutomationRevisionTable)
      .where(eq(AutomationRevisionTable.id, automation.current_revision_id)).limit(1)
    if (!current) throw new Error("automation_revision_not_found")
    let revisionId = current.id
    if (current.workspace_id) {
      const model = { providerId: current.provider_id, modelId: current.model_id, variant: current.model_variant ?? null }
      const action: AutomationAction = current.action ?? { kind: "agent", instructions: current.instructions, model }
      revisionId = createDenTypeId("automationRevision")
      await tx.insert(AutomationRevisionTable).values({
        id: revisionId,
        automation_id: automation.id,
        version: current.version + 1,
        instructions: current.instructions,
        schedule_kind: current.schedule_kind,
        schedule_config: current.schedule_config,
        timezone: current.timezone,
        provider_id: current.provider_id,
        model_id: current.model_id,
        model_variant: current.model_variant,
        action,
        execution_target: current.execution_target,
        workspace_id: null,
        maximum_runtime_ms: current.maximum_runtime_ms,
        digest: automationRevisionDigest({
          instructions: current.instructions,
          schedule: current.schedule_config,
          model,
          action,
          executionTarget: current.execution_target,
          maximumRuntimeMs: current.maximum_runtime_ms,
        }),
        created_at: new Date(input.now),
      })
    }
    await tx.update(AutomationTable).set({
      owner_member_id: toMemberId,
      current_revision_id: revisionId,
      state: "inactive",
      next_due_at: null,
      needs_attention_reason: null,
      updated_at: new Date(input.now),
    }).where(eq(AutomationTable.id, automation.id))
  })
}

/** Team deletion: its shares go with it (inside the team mutation). */
export async function deleteTeamAutomationShares(tx: TeamMutationTransaction, teamId: TeamId): Promise<void> {
  await tx.delete(AutomationTeamShareTable).where(eq(AutomationTeamShareTable.team_id, teamId))
}
