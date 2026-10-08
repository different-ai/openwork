import {
  PERMISSIONS,
  type PermissionDefaultSetKey,
} from "@openwork/types/den/permissions"
import {
  allowedKeys,
  ensureDefaultPermissionSets,
  isDefaultPermissionSetsMissingError,
  listActiveTeamPermissionSetsForTeams,
  listAuthoritativeTeamMemberships,
  readPermissionSetStates,
  reconcileDecisions,
  reconcileDefaultPermissionSets,
  type PermissionSetSummary,
} from "@openwork-ee/den-db/permissions"
import type { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { roleIncludesOwner } from "../organization-member-guards.js"
import { isEffectiveOrganizationAdmin } from "../organization-role-hierarchy.js"
import { resolveOrganizationMemberAuthority } from "../organization-team-roles.js"
import type { OrganizationContext } from "../orgs.js"
import { listTeamsForMember } from "../orgs.js"
import {
  codeDefaultPermissionGrants,
  createMemberPermissions,
  explainPermissionGrants,
  memberPermissionsFromGrants,
  ownerPermissionGrants,
  type MemberPermissions,
  type PermissionExplanation,
  type PermissionGrant,
} from "./effective.js"

/**
 * Server-side permission resolution (docs/permissions/overview.md, section 6).
 *
 * - Owner: every catalog key.
 * - Feature off: code defaults for Member, plus Admin for effective admins.
 *   The permission tables are not read.
 * - Feature on: the union of the Member default set, the Admin default set
 *   (effective admins only) and the active team sets of the member's teams.
 *   Team sets apply only through memberships that carry authority (the same
 *   SCIM projection rule as Admin teams; listAuthoritativeTeamMemberships).
 *   Default sets are created on first use. Only when they are missing and
 *   can't be created does resolution fall back to code defaults (logged);
 *   every other error fails closed and propagates, so a trimmed Admin set is
 *   never silently widened back to the code defaults.
 *
 * In request handlers use `c.var.memberPermissions` (orgPermissionRoute /
 * resolveMemberPermissionsMiddleware) or requirePermission / hasPermission in
 * routes/org/shared.ts. Outside a request, or for another member, use
 * `resolvePermissionsForMember`.
 */

export type { MemberPermissions, PermissionExplanation, PermissionSource } from "./effective.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const logger = appLogger.child({ component: "permissions" })

export type ResolveMemberPermissionsInput = {
  organizationId: OrganizationId
  memberId: MemberId
  isOwner: boolean
  /** The member's stored `member.role` (not the effective role). */
  directRole: string
  /** Teams with `grants_organization_admin` the member belongs to. */
  adminTeamIds: readonly string[]
  /**
   * Teams the member belongs to. Team sets apply only through those of these
   * memberships that carry authority (listAuthoritativeTeamMemberships).
   * Not read when the feature is off or the member is the owner.
   */
  teamIds: readonly string[]
  /** The organization's `permissions` feature, when already known (e.g. from OrganizationContext.features). */
  featureEnabled?: boolean
}

export type ExplainMemberPermissionsInput = Omit<ResolveMemberPermissionsInput, "adminTeamIds" | "teamIds"> & {
  adminTeams: readonly { id: string; name: string }[]
  teams: readonly { id: string }[]
}

export type MemberPermissionExplanation = {
  featureEnabled: boolean
  isOwner: boolean
  isAdmin: boolean
  permissions: PermissionExplanation[]
}

type PermissionSubject = {
  organizationId: OrganizationId
  memberId: MemberId
  isOwner: boolean
  directRole: string
  adminTeams: readonly { id: string; name: string | null }[]
  teamIds: readonly string[]
  featureEnabled?: boolean
}

type CollectedGrants = {
  featureEnabled: boolean
  isOwner: boolean
  isAdmin: boolean
  grants: PermissionGrant[]
}

function adminDefaultSources(subject: PermissionSubject, set: PermissionSetSummary, directAdmin: boolean): PermissionGrant["source"][] {
  const sources: PermissionGrant["source"][] = []
  if (directAdmin) sources.push({ kind: "admin_default", setId: set.id, setName: set.name, via: "role" })
  for (const team of subject.adminTeams) {
    sources.push({
      kind: "admin_default",
      setId: set.id,
      setName: set.name,
      via: "team",
      teamId: team.id,
      ...(team.name !== null ? { teamName: team.name } : {}),
    })
  }
  return sources
}

/** Team ids among `teamIds` whose membership carries authority for this member. */
async function authoritativeTeamIds(subject: PermissionSubject) {
  const requested = new Set<string>(subject.teamIds.map((teamId) => normalizeDenTypeId("team", teamId)))
  if (requested.size === 0) return []
  const memberships = await listAuthoritativeTeamMemberships(db, { organizationId: subject.organizationId, memberId: subject.memberId })
  return [...new Set(memberships.map((membership) => membership.teamId))].filter((teamId) => requested.has(teamId))
}

async function databaseGrants(subject: PermissionSubject, isAdmin: boolean): Promise<PermissionGrant[]> {
  const sets = await ensureDefaultPermissionSets(db, subject.organizationId)
  const teamIds = await authoritativeTeamIds(subject)
  const teamSets = teamIds.length > 0 ? await listActiveTeamPermissionSetsForTeams(db, subject.organizationId, teamIds) : []
  const defaultSets: { key: PermissionDefaultSetKey; set: PermissionSetSummary }[] = [{ key: "member", set: sets.member }]
  if (isAdmin) defaultSets.push({ key: "admin", set: sets.admin })
  const setIds = [...defaultSets.map(({ set }) => set.id), ...teamSets.map((teamSet) => teamSet.permissionSetId)]

  let states = await readPermissionSetStates(db, setIds)
  const needsReconcile = defaultSets.some(({ key, set }) => {
    const current = states.get(set.id) ?? new Map()
    return reconcileDecisions({ setDefaultKey: key, existingKeysEverSeen: new Set(current.keys()), currentStates: current, catalog: PERMISSIONS }).length > 0
  })
  if (needsReconcile) {
    // A deploy added catalog keys and deploy-time reconciliation has not
    // reached this org yet. Best-effort: a failed write never changes the
    // outcome; resolution continues with the states already read.
    try {
      const result = await reconcileDefaultPermissionSets(db, { organizationId: subject.organizationId })
      logger.info("permission default sets reconciled on read", { organization_id: subject.organizationId, rows_inserted: result.rowsInserted })
      states = await readPermissionSetStates(db, setIds)
    } catch (error) {
      logger.error("reconciling default permission sets on read failed; using the stored state", {
        organization_id: subject.organizationId,
        member_id: subject.memberId,
        error,
      })
    }
  }

  const grants: PermissionGrant[] = [{
    source: { kind: "member_default", setId: sets.member.id, setName: sets.member.name },
    keys: allowedKeys(states.get(sets.member.id)),
  }]
  if (isAdmin) {
    const adminKeys = allowedKeys(states.get(sets.admin.id))
    const directAdmin = isEffectiveOrganizationAdmin({ directRole: subject.directRole, adminTeamIds: [] })
    for (const source of adminDefaultSources(subject, sets.admin, directAdmin)) grants.push({ source, keys: adminKeys })
  }
  for (const teamSet of teamSets) {
    grants.push({
      source: { kind: "team", setId: teamSet.permissionSetId, setName: teamSet.permissionSetName, teamId: teamSet.teamId, teamName: teamSet.teamName },
      keys: allowedKeys(states.get(teamSet.permissionSetId)),
    })
  }
  return grants
}

async function collectPermissionGrants(subject: PermissionSubject): Promise<CollectedGrants> {
  const featureEnabled = subject.featureEnabled ?? await organizationFeatureEnabled(subject.organizationId, "permissions")
  const isAdmin = isEffectiveOrganizationAdmin({ directRole: subject.directRole, adminTeamIds: subject.adminTeams.map((team) => team.id) })
  if (subject.isOwner) return { featureEnabled, isOwner: true, isAdmin, grants: ownerPermissionGrants() }
  if (!featureEnabled) return { featureEnabled, isOwner: false, isAdmin, grants: codeDefaultPermissionGrants({ isAdmin }) }

  try {
    return { featureEnabled, isOwner: false, isAdmin, grants: await databaseGrants(subject, isAdmin) }
  } catch (error) {
    // Fail closed: only missing default sets (which should never happen, and
    // would otherwise lock the org out) fall back to code defaults.
    if (!isDefaultPermissionSetsMissingError(error)) throw error
    logger.error("permission default sets are missing; falling back to code defaults", {
      organization_id: subject.organizationId,
      member_id: subject.memberId,
      error,
    })
    return { featureEnabled, isOwner: false, isAdmin, grants: codeDefaultPermissionGrants({ isAdmin }) }
  }
}

/** Effective permissions for a member, from already-loaded membership data. */
export async function resolveMemberPermissions(input: ResolveMemberPermissionsInput): Promise<MemberPermissions> {
  return memberPermissionsFromGrants(await collectPermissionGrants({
    ...input,
    adminTeams: input.adminTeamIds.map((id) => ({ id, name: null })),
  }))
}

/** Effective permissions for the caller of an organization request. */
export function resolveMemberPermissionsFromContext(
  context: OrganizationContext,
  teamIds: readonly string[],
): Promise<MemberPermissions> {
  return resolveMemberPermissions({
    organizationId: context.organization.id,
    memberId: context.currentMember.id,
    isOwner: context.currentMember.isOwner,
    directRole: context.currentMember.directRole,
    adminTeamIds: context.currentMember.adminTeams.map((team) => team.id),
    teamIds,
    featureEnabled: context.features.permissions,
  })
}

/** Each allowed key with the sets (and teams) that allow it. For GET /v1/members/:id/permissions. */
export async function explainMemberPermissions(input: ExplainMemberPermissionsInput): Promise<MemberPermissionExplanation> {
  const collected = await collectPermissionGrants({ ...input, teamIds: input.teams.map((team) => team.id) })
  return {
    featureEnabled: collected.featureEnabled,
    isOwner: collected.isOwner,
    isAdmin: collected.isAdmin,
    permissions: explainPermissionGrants(collected.grants),
  }
}

/** Loads what resolution needs for any active member. Null when the member is missing, removed, or has no user yet. */
export async function loadPermissionSubject(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<ExplainMemberPermissionsInput | null> {
  const [authority, teams] = await Promise.all([
    resolveOrganizationMemberAuthority(input),
    listTeamsForMember(input),
  ])
  if (!authority) return null
  return {
    organizationId: input.organizationId,
    memberId: authority.id,
    isOwner: roleIncludesOwner(authority.directRole),
    directRole: authority.directRole,
    adminTeams: authority.adminTeams,
    teams,
  }
}

/**
 * Effective permissions of any member, e.g. an automation owner, an inviter,
 * or a member checked by a Better Auth hook. Fails closed: a missing or removed
 * member holds nothing.
 */
export async function resolvePermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
  featureEnabled?: boolean
}): Promise<MemberPermissions> {
  const subject = await loadPermissionSubject(input)
  if (!subject) {
    const featureEnabled = input.featureEnabled ?? await organizationFeatureEnabled(input.organizationId, "permissions")
    return createMemberPermissions({ featureEnabled, isOwner: false, isAdmin: false, keys: [] })
  }
  return memberPermissionsFromGrants(await collectPermissionGrants({
    ...subject,
    teamIds: subject.teams.map((team) => team.id),
    ...(input.featureEnabled !== undefined ? { featureEnabled: input.featureEnabled } : {}),
  }))
}

/**
 * The permission sets that apply to a member, in the order their rules apply:
 * Member, then Admin for admins, then each team's. Empty for the owner (who can
 * always do everything), a missing or removed member, or with Permissions off.
 */
export async function permissionSetsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<{ setId: string; setName: string }[]> {
  const subject = await loadPermissionSubject(input)
  if (!subject) return []
  const collected = await collectPermissionGrants({ ...subject, teamIds: subject.teams.map((team) => team.id) })
  const sets = new Map<string, string>()
  for (const { source } of collected.grants) {
    if ("setId" in source && !sets.has(source.setId)) sets.set(source.setId, source.setName)
  }
  return [...sets].map(([setId, setName]) => ({ setId, setName }))
}

/** `explainMemberPermissions` for any member, or null when the member is missing or removed. */
export async function explainPermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<MemberPermissionExplanation | null> {
  const subject = await loadPermissionSubject(input)
  return subject ? explainMemberPermissions(subject) : null
}
