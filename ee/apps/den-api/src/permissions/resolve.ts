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
  listActiveMemberPermissionSets,
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
import { appLogger } from "../observability/logger.js"
import { roleIncludesOwner } from "../organization-member-guards.js"
import { isEffectiveOrganizationAdmin, isOrganizationSuperAdminRole } from "../organization-role-hierarchy.js"
import type { OrganizationContext } from "../orgs.js"
import {
  createMemberPermissions,
  explainPermissionGrants,
  memberPermissionsFromGrants,
  missingDefaultSetsPermissionGrants,
  ownerPermissionGrants,
  type MemberPermissions,
  type PermissionExplanation,
  type PermissionGrant,
} from "./effective.js"

export type { MemberPermissions, PermissionExplanation, PermissionSource } from "./effective.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const logger = appLogger.child({ component: "permissions" })

export type ResolveMemberPermissionsInput = {
  organizationId: OrganizationId
  memberId: MemberId
  isOwner: boolean
  directRole: string
  adminTeamIds: readonly string[]
  teamIds: readonly string[]
}

export type ExplainMemberPermissionsInput = Omit<ResolveMemberPermissionsInput, "adminTeamIds" | "teamIds"> & {
  adminTeams: readonly { id: string; name: string }[]
  teams: readonly { id: string }[]
}

export type MemberPermissionExplanation = {
  featureEnabled: boolean
  isOwner: boolean
  isSuperAdmin: boolean
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
}

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

type DefaultSetMembership = {
  isAdmin: boolean
  isSuperAdmin: boolean
}

type CollectedGrants = {
  isOwner: boolean
  isSuperAdmin: boolean
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

async function defaultPermissionSets(
  organizationId: OrganizationId,
  membership: DefaultSetMembership,
  reads: PermissionReads,
): Promise<Pick<DefaultPermissionSets, "member" | "admin"> & { "super-admin": PermissionSetSummary | null }> {
  if (!reads.transaction) return ensureDefaultPermissionSets(db, organizationId)
  const stored = await getDefaultPermissionSets(reads.database, organizationId, readLock(reads))
  if (!stored.member || !stored.admin) throw new DefaultPermissionSetsMissingError(organizationId)
  if (membership.isSuperAdmin && !stored["super-admin"]) throw new DefaultPermissionSetsMissingError(organizationId)
  return { member: stored.member, admin: stored.admin, "super-admin": stored["super-admin"] }
}

async function databaseGrants(subject: PermissionSubject, membership: DefaultSetMembership, reads: PermissionReads): Promise<PermissionGrant[]> {
  const { isAdmin, isSuperAdmin } = membership
  const sets = await defaultPermissionSets(subject.organizationId, membership, reads)
  const superAdminSet = isSuperAdmin ? sets["super-admin"] : null
  const teamIds = await authoritativeTeamIds(subject, reads)
  const teamSets = teamIds.length > 0
    ? await listActiveTeamPermissionSetsForTeams(reads.database, subject.organizationId, teamIds, readLock(reads))
    : []
  const directSets = await listActiveMemberPermissionSets(reads.database, {
    organizationId: subject.organizationId,
    memberId: subject.memberId,
    ...readLock(reads),
  })
  const defaultSets: { key: PermissionDefaultSetKey; set: Pick<PermissionSetSummary, "id"> }[] = [{ key: "member", set: sets.member }]
  if (isAdmin) defaultSets.push({ key: "admin", set: sets.admin })
  if (superAdminSet) defaultSets.push({ key: "super-admin", set: superAdminSet })
  for (const linked of [...teamSets, ...directSets]) {
    if (linked.defaultKey && !defaultSets.some(({ set }) => set.id === linked.permissionSetId)) {
      defaultSets.push({ key: linked.defaultKey, set: { id: linked.permissionSetId } })
    }
  }
  const setIds = [...new Set([
    ...defaultSets.map(({ set }) => set.id),
    ...teamSets.map((teamSet) => teamSet.permissionSetId),
    ...directSets.map((directSet) => directSet.permissionSetId),
  ])]

  let states = await readPermissionSetStates(reads.database, setIds, readLock(reads))
  const needsReconcile = defaultSets.some(({ key, set }) => {
    const current = states.get(set.id) ?? new Map()
    return reconcileDecisions({ setDefaultKey: key, existingKeysEverSeen: new Set(current.keys()), currentStates: current, catalog: PERMISSIONS }).length > 0
  })
  if (needsReconcile && !reads.transaction) {
    try {
      const result = await reconcileDefaultPermissionSets(db, { organizationId: subject.organizationId })
      logger.info("permission default sets reconciled on read", { organization_id: subject.organizationId, rows_inserted: result.rowsInserted })
      states = await db.transaction((tx) => readPermissionSetStates(tx, setIds))
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
  if (superAdminSet) {
    grants.push({
      source: { kind: "super_admin_default", setId: superAdminSet.id, setName: superAdminSet.name },
      keys: allowedKeys(states.get(superAdminSet.id)),
    })
  }
  for (const teamSet of teamSets) {
    grants.push({
      source: { kind: "team", setId: teamSet.permissionSetId, setName: teamSet.permissionSetName, teamId: teamSet.teamId, teamName: teamSet.teamName },
      keys: allowedKeys(states.get(teamSet.permissionSetId)),
    })
  }
  for (const directSet of directSets) {
    grants.push({
      source: { kind: "direct", setId: directSet.permissionSetId, setName: directSet.permissionSetName },
      keys: allowedKeys(states.get(directSet.permissionSetId)),
    })
  }
  return grants
}

async function collectPermissionGrants(subject: PermissionSubject, reads: PermissionReads = ROOT_READS): Promise<CollectedGrants> {
  const effectiveAdmin = isEffectiveOrganizationAdmin({ directRole: subject.directRole, adminTeamIds: subject.adminTeams.map((team) => team.id) })
  if (subject.isOwner) return { isOwner: true, isSuperAdmin: false, isAdmin: effectiveAdmin, grants: ownerPermissionGrants() }
  const isSuperAdmin = isOrganizationSuperAdminRole(subject.directRole)
  const isAdmin = effectiveAdmin || isSuperAdmin

  try {
    return { isOwner: false, isSuperAdmin, isAdmin, grants: await databaseGrants(subject, { isAdmin, isSuperAdmin }, reads) }
  } catch (error) {
    if (!isDefaultPermissionSetsMissingError(error)) throw error
    logger.error(reads.transaction
      ? "permission default sets are missing inside a transaction; denying"
      : "permission default sets are missing; falling back to code defaults", {
      organization_id: subject.organizationId,
      member_id: subject.memberId,
      error,
    })
    return { isOwner: false, isSuperAdmin, isAdmin, grants: missingDefaultSetsPermissionGrants({ isAdmin, isSuperAdmin, transaction: reads.transaction }) }
  }
}

export async function resolveMemberPermissions(input: ResolveMemberPermissionsInput): Promise<MemberPermissions> {
  return memberPermissionsFromGrants(await collectPermissionGrants({
    ...input,
    adminTeams: input.adminTeamIds.map((id) => ({ id, name: null })),
  }))
}

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
  })
}

export async function explainMemberPermissions(input: ExplainMemberPermissionsInput): Promise<MemberPermissionExplanation> {
  const collected = await collectPermissionGrants({ ...input, teamIds: input.teams.map((team) => team.id) })
  return {
    featureEnabled: true,
    isOwner: collected.isOwner,
    isSuperAdmin: collected.isSuperAdmin,
    isAdmin: collected.isAdmin,
    permissions: explainPermissionGrants(collected.grants),
  }
}

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

export async function resolvePermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
  database?: PermissionDatabase
}): Promise<MemberPermissions> {
  const reads = permissionReads(input.database)
  const subject = await loadPermissionSubject(input, reads)
  if (!subject) {
    return createMemberPermissions({ isOwner: false, isAdmin: false, keys: [] })
  }
  return memberPermissionsFromGrants(await collectPermissionGrants({
    ...subject,
    teamIds: subject.teams.map((team) => team.id),
  }, reads))
}

export async function explainPermissionsForMember(input: {
  organizationId: OrganizationId
  memberId: MemberId
}): Promise<MemberPermissionExplanation | null> {
  const subject = await loadPermissionSubject(input)
  return subject ? explainMemberPermissions(subject) : null
}
