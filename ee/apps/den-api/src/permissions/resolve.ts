import {
  PERMISSIONS,
  type PermissionDefaultSetKey,
} from "@openwork/types/den/permissions"
import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  DefaultPermissionSetsMissingError,
  allowedKeys,
  ensureDefaultPermissionSets,
  getDefaultPermissionSets,
  isDefaultPermissionSetsMissingError,
  listActiveTeamPermissionSetsForTeams,
  listAuthoritativeTeamMemberships,
  readPermissionSetStates,
  reconcileDecisions,
  reconcileDefaultPermissionSets,
  type DefaultPermissionSets,
  type PermissionDatabase,
  type PermissionSetSummary,
} from "@openwork-ee/den-db/permissions"
import { MemberTable, TeamMemberTable, TeamTable, type OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { roleIncludesOwner } from "../organization-member-guards.js"
import { isEffectiveOrganizationAdmin } from "../organization-role-hierarchy.js"
import type { OrganizationContext } from "../orgs.js"
import {
  codeDefaultPermissionGrants,
  createMemberPermissions,
  explainPermissionGrants,
  memberPermissionsFromGrants,
  missingDefaultSetsPermissionGrants,
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
 *
 * Inside a write transaction that must not act on a permission revoked since
 * the route check, call `resolvePermissionsForMember({ ..., database: tx })`.
 * That mode reads only through `tx` (no second pool connection), with share
 * locks so it sees the latest committed rows and holds them until commit, and
 * never writes: no lazy default-set creation or catalog reconciliation. Missing
 * default sets then deny everything (logged) instead of using code defaults.
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

/**
 * Where resolution reads. `transaction`: read-only, locking reads through
 * `database` (see the module comment). Otherwise the root database, with lazy
 * default-set creation and reconciliation.
 */
type PermissionReads = {
  database: PermissionDatabase
  transaction: boolean
}

const ROOT_READS: PermissionReads = { database: db, transaction: false }

function permissionReads(database: PermissionDatabase | undefined): PermissionReads {
  return database ? { database, transaction: true } : ROOT_READS
}

function readLock(reads: PermissionReads): { lock?: "share" } {
  return reads.transaction ? { lock: "share" } : {}
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
async function authoritativeTeamIds(subject: PermissionSubject, reads: PermissionReads) {
  const requested = new Set<string>(subject.teamIds.map((teamId) => normalizeDenTypeId("team", teamId)))
  if (requested.size === 0) return []
  const memberships = await listAuthoritativeTeamMemberships(reads.database, {
    organizationId: subject.organizationId,
    memberId: subject.memberId,
    ...readLock(reads),
  })
  return [...new Set(memberships.map((membership) => membership.teamId))].filter((teamId) => requested.has(teamId))
}

/** The default sets. Created on first use, except in a transaction, where missing sets throw. */
async function defaultPermissionSets(organizationId: OrganizationId, reads: PermissionReads): Promise<DefaultPermissionSets> {
  if (!reads.transaction) return ensureDefaultPermissionSets(db, organizationId)
  const stored = await getDefaultPermissionSets(reads.database, organizationId, readLock(reads))
  if (!stored.member || !stored.admin) throw new DefaultPermissionSetsMissingError(organizationId)
  return { member: stored.member, admin: stored.admin }
}

async function databaseGrants(subject: PermissionSubject, isAdmin: boolean, reads: PermissionReads): Promise<PermissionGrant[]> {
  const sets = await defaultPermissionSets(subject.organizationId, reads)
  const teamIds = await authoritativeTeamIds(subject, reads)
  const teamSets = teamIds.length > 0
    ? await listActiveTeamPermissionSetsForTeams(reads.database, subject.organizationId, teamIds, readLock(reads))
    : []
  const defaultSets: { key: PermissionDefaultSetKey; set: PermissionSetSummary }[] = [{ key: "member", set: sets.member }]
  if (isAdmin) defaultSets.push({ key: "admin", set: sets.admin })
  const setIds = [...defaultSets.map(({ set }) => set.id), ...teamSets.map((teamSet) => teamSet.permissionSetId)]

  let states = await readPermissionSetStates(reads.database, setIds, readLock(reads))
  const needsReconcile = defaultSets.some(({ key, set }) => {
    const current = states.get(set.id) ?? new Map()
    return reconcileDecisions({ setDefaultKey: key, existingKeysEverSeen: new Set(current.keys()), currentStates: current, catalog: PERMISSIONS }).length > 0
  })
  // A transaction never writes: keys not reconciled yet stay denied, as when reconciling fails.
  if (needsReconcile && !reads.transaction) {
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

function permissionsFeatureEnabled(organizationId: OrganizationId, reads: PermissionReads) {
  return organizationFeatureEnabled(organizationId, "permissions", reads.transaction ? { database: reads.database, lock: "share" } : {})
}

async function collectPermissionGrants(subject: PermissionSubject, reads: PermissionReads = ROOT_READS): Promise<CollectedGrants> {
  const featureEnabled = subject.featureEnabled ?? await permissionsFeatureEnabled(subject.organizationId, reads)
  const isAdmin = isEffectiveOrganizationAdmin({ directRole: subject.directRole, adminTeamIds: subject.adminTeams.map((team) => team.id) })
  if (subject.isOwner) return { featureEnabled, isOwner: true, isAdmin, grants: ownerPermissionGrants() }
  if (!featureEnabled) return { featureEnabled, isOwner: false, isAdmin, grants: codeDefaultPermissionGrants({ isAdmin }) }

  try {
    return { featureEnabled, isOwner: false, isAdmin, grants: await databaseGrants(subject, isAdmin, reads) }
  } catch (error) {
    // Fail closed: only missing default sets (which should never happen, and
    // would otherwise lock the org out) fall back to code defaults, and only
    // outside a transaction; inside one they deny everything.
    if (!isDefaultPermissionSetsMissingError(error)) throw error
    logger.error(reads.transaction
      ? "permission default sets are missing inside a transaction; denying"
      : "permission default sets are missing; falling back to code defaults", {
      organization_id: subject.organizationId,
      member_id: subject.memberId,
      error,
    })
    return { featureEnabled, isOwner: false, isAdmin, grants: missingDefaultSetsPermissionGrants({ isAdmin, transaction: reads.transaction }) }
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

/**
 * Loads what resolution needs for any active member. Null when the member is
 * missing, removed, or has no user yet. Admin teams follow the authoritative
 * membership rule (listAuthoritativeTeamMemberships), as
 * resolveOrganizationMemberAuthority does.
 */
export async function loadPermissionSubject(
  input: { organizationId: OrganizationId; memberId: MemberId },
  reads: PermissionReads = ROOT_READS,
): Promise<ExplainMemberPermissionsInput | null> {
  const { database } = reads
  const lock = readLock(reads)
  const memberQuery = database.select({ id: MemberTable.id, role: MemberTable.role, userId: MemberTable.userId })
    .from(MemberTable)
    .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
    .limit(1)
  const [member] = lock.lock ? await memberQuery.for(lock.lock) : await memberQuery
  if (!member?.userId) return null
  const readAdminTeams = () => listAuthoritativeTeamMemberships(database, {
    organizationId: input.organizationId,
    memberId: member.id,
    adminTeamsOnly: true,
    ...lock,
  })
  const readTeams = async () => {
    const query = database.select({ id: TeamTable.id })
      .from(TeamMemberTable)
      .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
      .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, member.id)))
      .orderBy(asc(TeamTable.createdAt))
    return lock.lock ? await query.for(lock.lock) : await query
  }
  // A transaction runs one query at a time on its connection.
  const [adminTeams, teams] = reads.transaction
    ? [await readAdminTeams(), await readTeams()]
    : await Promise.all([readAdminTeams(), readTeams()])
  return {
    organizationId: input.organizationId,
    memberId: member.id,
    isOwner: roleIncludesOwner(member.role),
    directRole: member.role,
    adminTeams: adminTeams.map((team) => ({ id: team.teamId, name: team.teamName })),
    teams,
  }
}

/**
 * Effective permissions of any member, e.g. an automation owner, an inviter,
 * or a member checked by a Better Auth hook. Fails closed: a missing or removed
 * member holds nothing.
 *
 * Pass `database: tx` to re-check inside a write transaction: every read goes
 * through `tx` with share locks and nothing is written (see the module comment).
 */
export async function resolvePermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
  featureEnabled?: boolean
  database?: PermissionDatabase
}): Promise<MemberPermissions> {
  const reads = permissionReads(input.database)
  const subject = await loadPermissionSubject(input, reads)
  if (!subject) {
    const featureEnabled = input.featureEnabled ?? await permissionsFeatureEnabled(input.organizationId, reads)
    return createMemberPermissions({ featureEnabled, isOwner: false, isAdmin: false, keys: [] })
  }
  return memberPermissionsFromGrants(await collectPermissionGrants({
    ...subject,
    teamIds: subject.teams.map((team) => team.id),
    ...(input.featureEnabled !== undefined ? { featureEnabled: input.featureEnabled } : {}),
  }, reads))
}

/** `explainMemberPermissions` for any member, or null when the member is missing or removed. */
export async function explainPermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<MemberPermissionExplanation | null> {
  const subject = await loadPermissionSubject(input)
  return subject ? explainMemberPermissions(subject) : null
}
