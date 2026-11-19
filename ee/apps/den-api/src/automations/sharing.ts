import { and, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, AutomationRevisionTable, AutomationShareTable, AutomationTable, MemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationSharing, SharedAutomation } from "@openwork/types/automations"
import { db } from "../db.js"
import { listTeamsForMember } from "../member-teams.js"
import { withPrimaryReads } from "../read-routing.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { keysetPage, type KeysetCursor } from "../list-pagination.js"

type Scope = { organizationId: string; ownerMemberId: string }
const identities = (scope: Scope) => ({
  organizationId: normalizeDenTypeId("organization", scope.organizationId),
  memberId: normalizeDenTypeId("member", scope.ownerMemberId),
})

function ownerFilter(scope: Scope, id: string) {
  const caller = identities(scope)
  return and(eq(AutomationTable.id, normalizeDenTypeId("automation", id)),
    eq(AutomationTable.organization_id, caller.organizationId), eq(AutomationTable.owner_member_id, caller.memberId))
}

function audience(rows: Array<typeof AutomationShareTable.$inferSelect>): AutomationSharing {
  return {
    orgWide: rows.some((row) => row.org_wide),
    memberIds: rows.flatMap((row) => row.org_membership_id ? [row.org_membership_id] : []),
    teamIds: rows.flatMap((row) => row.team_id ? [row.team_id] : []),
  }
}

export async function getAutomationSharing(scope: Scope, id: string, options: { requireUnarchived?: boolean } = {}): Promise<AutomationSharing> {
  if (!isDenTypeId("automation", id)) throw new Error("automation_not_found")
  const [owner] = await db.$primary.select({ id: AutomationTable.id }).from(AutomationTable).where(and(
    ownerFilter(scope, id), options.requireUnarchived ? ne(AutomationTable.state, "archived") : undefined,
  )).limit(1)
  if (!owner) throw new Error("automation_not_found")
  return audience(await db.$primary.select().from(AutomationShareTable).where(eq(AutomationShareTable.automation_id, owner.id)))
}

export async function replaceAutomationSharing(scope: Scope, id: string, requested: AutomationSharing): Promise<AutomationSharing> {
  if (!isDenTypeId("automation", id)) throw new Error("automation_not_found")
  const caller = identities(scope)
  if (requested.memberIds.some((id) => !isDenTypeId("member", id)) || requested.teamIds.some((id) => !isDenTypeId("team", id))) {
    throw new Error("automation_share_target_invalid")
  }
  const memberIds = [...new Set(requested.memberIds.map((id) => normalizeDenTypeId("member", id)))].filter((id) => id !== caller.memberId)
  const teamIds = [...new Set(requested.teamIds.map((id) => normalizeDenTypeId("team", id)))]
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
      eq(MemberTable.id, caller.memberId), eq(MemberTable.organizationId, caller.organizationId), peopleMemberCondition(),
    )).for("share")
    if (!member) throw new Error("automation_not_found")
    const [owner] = await tx.select({ id: AutomationTable.id }).from(AutomationTable).where(and(
      ownerFilter(scope, id), ne(AutomationTable.state, "archived"),
    )).for("update")
    if (!owner) throw new Error("automation_not_found")
    const members = memberIds.length ? await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
      eq(MemberTable.organizationId, caller.organizationId), inArray(MemberTable.id, memberIds), peopleMemberCondition(), isNotNull(MemberTable.userId),
    )).for("share") : []
    const teams = teamIds.length ? await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(
      eq(TeamTable.organizationId, caller.organizationId), inArray(TeamTable.id, teamIds),
    )).for("share") : []
    if (members.length !== memberIds.length || teams.length !== teamIds.length) throw new Error("automation_share_target_invalid")
    const existing = await tx.select().from(AutomationShareTable).where(eq(AutomationShareTable.automation_id, owner.id))
    const desired: AutomationSharing = requested.orgWide ? { orgWide: true, memberIds: [], teamIds: [] } : { orgWide: false, memberIds, teamIds }
    const retained = existing.filter((row) => row.org_wide ? desired.orgWide
      : row.org_membership_id ? desired.memberIds.includes(row.org_membership_id)
        : row.team_id ? desired.teamIds.includes(row.team_id) : false)
    const removed = existing.filter((row) => !retained.includes(row))
    if (removed.length) await tx.delete(AutomationShareTable).where(inArray(AutomationShareTable.id, removed.map((row) => row.id)))
    const base = { organization_id: caller.organizationId, automation_id: owner.id, created_by_org_membership_id: caller.memberId }
    const additions = [
      ...(desired.orgWide && !retained.some((row) => row.org_wide) ? [{ ...base, id: createDenTypeId("automationShare"), org_wide: true }] : []),
      ...memberIds.filter((id) => !desired.orgWide && !retained.some((row) => row.org_membership_id === id))
        .map((id) => ({ ...base, id: createDenTypeId("automationShare"), org_membership_id: id })),
      ...teamIds.filter((id) => !desired.orgWide && !retained.some((row) => row.team_id === id))
        .map((id) => ({ ...base, id: createDenTypeId("automationShare"), team_id: id })),
    ]
    if (additions.length) await tx.insert(AutomationShareTable).values(additions)
    return desired
  })
}

export const SHARED_AUTOMATION_PAGE_MAX = 200

type SharedAutomationQuery = { automationId?: string; cursor?: KeysetCursor; limit?: number }

/** Definition-only read: never reconciles or loads the source's runs or results. Newest share first. */
export function listSharedAutomations(scope: Scope, query: SharedAutomationQuery = {}): Promise<{ items: SharedAutomation[]; nextCursor: string | null }> {
  return withPrimaryReads(() => readSharedAutomations(scope, query))
}

async function readSharedAutomations(scope: Scope, query: SharedAutomationQuery): Promise<{ items: SharedAutomation[]; nextCursor: string | null }> {
  const caller = identities(scope)
  const { automationId, cursor } = query
  const limit = query.limit ?? SHARED_AUTOMATION_PAGE_MAX
  if (automationId && !isDenTypeId("automation", automationId)) return { items: [], nextCursor: null }
  if (cursor && !isDenTypeId("automation", cursor.id)) return { items: [], nextCursor: null }
  const teams = await listTeamsForMember(caller)
  // The cursor time is bound with the share column's own encoding (UTC), as
  // the aggregate has no column to encode it.
  const afterCursor = (sharedAt: typeof grants.sharedAt, after: KeysetCursor) => {
    const at = sql.param(after.at, AutomationShareTable.created_at)
    return or(lt(sharedAt, at), and(eq(sharedAt, at), lt(AutomationTable.id, normalizeDenTypeId("automation", after.id))))
  }
  const grants = db.select({
    automationId: AutomationShareTable.automation_id,
    sharedAt: sql<Date>`min(${AutomationShareTable.created_at})`.mapWith(AutomationShareTable.created_at).as("shared_at"),
  }).from(AutomationShareTable).where(and(eq(AutomationShareTable.organization_id, caller.organizationId), or(
    eq(AutomationShareTable.org_wide, true), eq(AutomationShareTable.org_membership_id, caller.memberId),
    teams.length ? inArray(AutomationShareTable.team_id, teams.map((team) => team.id)) : undefined,
  ))).groupBy(AutomationShareTable.automation_id).as("matching_automation_grants")
  const rows = await db.select({
    id: AutomationTable.id, name: AutomationTable.name, memberId: MemberTable.id, ownerName: AuthUserTable.name,
    sharedAt: grants.sharedAt, schedule: AutomationRevisionTable.schedule_config,
    executionTarget: AutomationRevisionTable.execution_target, action: AutomationRevisionTable.action,
    instructions: AutomationRevisionTable.instructions, providerId: AutomationRevisionTable.provider_id,
    modelId: AutomationRevisionTable.model_id, variant: AutomationRevisionTable.model_variant,
  }).from(AutomationTable)
    .innerJoin(grants, eq(grants.automationId, AutomationTable.id))
    .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationTable.current_revision_id))
    .innerJoin(MemberTable, and(eq(MemberTable.id, AutomationTable.owner_member_id), eq(MemberTable.organizationId, caller.organizationId)))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(AutomationTable.organization_id, caller.organizationId), ne(AutomationTable.owner_member_id, caller.memberId),
      ne(AutomationTable.state, "archived"), peopleMemberCondition(),
      automationId ? eq(AutomationTable.id, normalizeDenTypeId("automation", automationId)) : undefined,
      cursor ? afterCursor(grants.sharedAt, cursor) : undefined))
    .orderBy(desc(grants.sharedAt), desc(AutomationTable.id)).limit(limit + 1)
  const page = keysetPage(rows, limit, (row) => ({ at: row.sharedAt, id: row.id }))
  return { nextCursor: page.nextCursor, items: page.items.map((row) => ({
    id: row.id, name: row.name, sharedBy: { memberId: row.memberId, name: row.ownerName },
    sharedAt: row.sharedAt.toISOString(), schedule: row.schedule, executionTarget: row.executionTarget,
    action: row.action ?? { kind: "agent", instructions: row.instructions, model: { providerId: row.providerId, modelId: row.modelId, variant: row.variant } },
  })) }
}
