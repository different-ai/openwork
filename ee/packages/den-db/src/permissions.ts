import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  PERMISSIONS,
  PERMISSION_DEFAULT_SET_KEYS,
  permissionDefaultKeys,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import { alias } from "drizzle-orm/mysql-core"
import type { createDenDb } from "./client"
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "./drizzle"
import {
  DefaultPermissionSetsMissingError,
  buildPermissionRows,
  currentPermissionStates,
  reconcileDecisions,
  type PermissionCatalogEntry,
  type PermissionHistoryRow,
  type PermissionKeyStates,
} from "./permission-states"
import {
  MemberTable,
  PermissionSetPermissionTable,
  PermissionSetTable,
  PermissionSetTeamTable,
  ScimGroupMemberTable,
  ScimGroupTable,
  ScimProviderTable,
  TeamMemberTable,
  TeamTable,
  type PermissionStatus,
} from "./schema"

export * from "./permission-states"

/**
 * Data access for organization permissions (docs/permissions/overview.md,
 * sections 5, 6 and 8).
 *
 * - `permission_set_permission` is append-only. The latest row by
 *   (created_at, id) for a set and key is its current state; no row means
 *   denied. Never update or delete rows: insert a new one.
 * - Keys that are no longer in the catalog are ignored on read.
 * - Writers that change a set's rows (the edit endpoint, reconciliation) must
 *   call `lockPermissionSet` inside their transaction before reading the
 *   current state, so concurrent writers serialize per set.
 */

type Db = ReturnType<typeof createDenDb>["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
/** The root database or a transaction. */
export type PermissionDatabase = Db | Tx

type OrganizationId = typeof PermissionSetTable.$inferSelect.organizationId
type PermissionSetId = typeof PermissionSetTable.$inferSelect.id
type TeamId = typeof PermissionSetTeamTable.$inferSelect.teamId
type MemberId = typeof MemberTable.$inferSelect.id

export const DEFAULT_PERMISSION_SET_NAMES: Readonly<Record<PermissionDefaultSetKey, string>> = {
  member: "Member permissions",
  admin: "Admin permissions",
}

const ID_CHUNK_SIZE = 500
const RECONCILE_BATCH_SIZE = 200

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

export type PermissionSetSummary = {
  id: PermissionSetId
  organizationId: OrganizationId
  defaultKey: PermissionDefaultSetKey | null
  name: string
  createdAt: Date
  archivedAt: Date | null
}

export type DefaultPermissionSets = Record<PermissionDefaultSetKey, PermissionSetSummary>

export type ActiveTeamPermissionSet = {
  permissionSetId: PermissionSetId
  permissionSetName: string
  teamId: TeamId
  teamName: string
}

export type ReconcilePermissionSetsResult = {
  setsChecked: number
  setsChanged: number
  rowsInserted: number
}

const permissionSetColumns = {
  id: PermissionSetTable.id,
  organizationId: PermissionSetTable.organizationId,
  defaultKey: PermissionSetTable.defaultKey,
  name: PermissionSetTable.name,
  createdAt: PermissionSetTable.createdAt,
  archivedAt: PermissionSetTable.archivedAt,
}

/** Runs `run` in a transaction, or in a savepoint when `database` already is one. */
function inTransaction<T>(database: PermissionDatabase, run: (tx: Tx) => Promise<T>): Promise<T> {
  return database.transaction(run)
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** MySQL / PlanetScale duplicate-key error, possibly wrapped by drizzle. */
export function isPermissionDuplicateKeyError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!isRecord(error) || seen.has(error)) return false
  seen.add(error)
  if (error.code === "ER_DUP_ENTRY" || error.code === "ALREADY_EXISTS" || error.errno === 1062) return true
  if (typeof error.message === "string" && error.message.includes("Duplicate entry")) return true
  return isPermissionDuplicateKeyError(error.cause, seen) || isPermissionDuplicateKeyError(error.body, seen)
}

/**
 * Locks a permission set row of one organization until the transaction ends.
 * Call it first in any transaction that reads a set's current state and then
 * inserts rows for it. False when the set does not exist in that organization.
 */
export async function lockPermissionSet(tx: Tx, organizationId: OrganizationId, permissionSetId: PermissionSetId): Promise<boolean> {
  const rows = await tx.select({ id: PermissionSetTable.id })
    .from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.id, permissionSetId), eq(PermissionSetTable.organizationId, organizationId)))
    .limit(1)
    .for("update")
  return rows.length > 0
}

/**
 * When the set's latest permission row was written, or null when it has none.
 * Read under lockPermissionSet and pass to buildPermissionRows as `notBefore`.
 */
export async function latestPermissionRowCreatedAt(tx: Tx, permissionSetId: PermissionSetId): Promise<Date | null> {
  const [row] = await tx.select({ createdAt: PermissionSetPermissionTable.createdAt })
    .from(PermissionSetPermissionTable)
    .where(eq(PermissionSetPermissionTable.permissionSetId, permissionSetId))
    .orderBy(desc(PermissionSetPermissionTable.createdAt), desc(PermissionSetPermissionTable.id))
    .limit(1)
    .for("share")
  return row?.createdAt ?? null
}

/** The organization's Member and Admin default sets, or null where missing. */
export async function getDefaultPermissionSets(
  database: PermissionDatabase,
  organizationId: OrganizationId,
  options: { lock?: "share" } = {},
): Promise<Record<PermissionDefaultSetKey, PermissionSetSummary | null>> {
  const query = database.select(permissionSetColumns)
    .from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.organizationId, organizationId), isNotNull(PermissionSetTable.defaultKey)))
  const rows = options.lock ? await query.for(options.lock) : await query
  const result: Record<PermissionDefaultSetKey, PermissionSetSummary | null> = { member: null, admin: null }
  for (const row of rows) {
    if (row.defaultKey) result[row.defaultKey] = row
  }
  return result
}

/**
 * Idempotently creates the Member and Admin default sets for an organization,
 * each seeded (`source = 'seed'`) with an allow row for every catalog key whose
 * `defaultOn` includes it. Existing sets are returned unchanged and never
 * re-seeded. Safe under concurrent calls: the unique index on
 * (organization_id, default_key) makes a losing caller re-read the winner's sets.
 * Prefer the root database; inside a transaction the sets are created in a savepoint.
 */
export async function ensureDefaultPermissionSets(
  database: PermissionDatabase,
  organizationId: OrganizationId,
): Promise<DefaultPermissionSets> {
  const existing = await getDefaultPermissionSets(database, organizationId)
  if (existing.member && existing.admin) return { member: existing.member, admin: existing.admin }

  try {
    await inTransaction(database, async (tx) => {
      const current = await getDefaultPermissionSets(tx, organizationId)
      const now = new Date()
      for (const defaultKey of PERMISSION_DEFAULT_SET_KEYS) {
        if (current[defaultKey]) continue
        const permissionSetId = createDenTypeId("permissionSet")
        await tx.insert(PermissionSetTable).values({
          id: permissionSetId,
          organizationId,
          defaultKey,
          name: DEFAULT_PERMISSION_SET_NAMES[defaultKey],
          createdAt: now,
        })
        const rows = buildPermissionRows({
          organizationId,
          permissionSetId,
          changes: permissionDefaultKeys(defaultKey).map((key) => ({ key, status: "allow" })),
          source: "seed",
          now,
        })
        if (rows.length > 0) await tx.insert(PermissionSetPermissionTable).values(rows)
      }
    })
  } catch (error) {
    if (!isPermissionDuplicateKeyError(error)) throw error
  }

  // A locking read sees sets committed by a concurrent caller even when
  // `database` is a transaction whose snapshot predates them.
  const created = await getDefaultPermissionSets(database, organizationId, { lock: "share" })
  if (!created.member || !created.admin) throw new DefaultPermissionSetsMissingError(organizationId)
  return { member: created.member, admin: created.admin }
}

/**
 * Current status per key for each requested set (sets without rows map to an
 * empty map). Includes keys no longer in the catalog; filter with `allowedKeys`.
 * `lock: "share"` reads the latest committed rows inside a transaction.
 */
export async function readPermissionSetStates(
  database: PermissionDatabase,
  setIds: readonly PermissionSetId[],
  options: { lock?: "share" } = {},
): Promise<Map<PermissionSetId, Map<string, PermissionStatus>>> {
  const uniqueIds = [...new Set(setIds)]
  const rows: PermissionHistoryRow<PermissionSetId>[] = []
  for (const chunk of chunks(uniqueIds, ID_CHUNK_SIZE)) {
    const query = database.select({
      id: PermissionSetPermissionTable.id,
      permissionSetId: PermissionSetPermissionTable.permissionSetId,
      permissionKey: PermissionSetPermissionTable.permissionKey,
      status: PermissionSetPermissionTable.status,
      createdAt: PermissionSetPermissionTable.createdAt,
    })
      .from(PermissionSetPermissionTable)
      .where(inArray(PermissionSetPermissionTable.permissionSetId, chunk))
    rows.push(...(options.lock ? await query.for(options.lock) : await query))
  }

  const states = currentPermissionStates(rows)
  for (const setId of uniqueIds) {
    if (!states.has(setId)) states.set(setId, new Map())
  }
  return states
}

/**
 * Team permission sets that apply to members of the given teams: the link is
 * not removed and the set is not archived. One row per (set, team) link.
 * `lock: "share"` reads the latest committed links inside a transaction.
 */
export async function listActiveTeamPermissionSetsForTeams(
  database: PermissionDatabase,
  organizationId: OrganizationId,
  teamIds: readonly TeamId[],
  options: { lock?: "share" } = {},
): Promise<ActiveTeamPermissionSet[]> {
  const uniqueIds = [...new Set(teamIds)]
  const result: ActiveTeamPermissionSet[] = []
  for (const chunk of chunks(uniqueIds, ID_CHUNK_SIZE)) {
    const query = database.select({
      permissionSetId: PermissionSetTable.id,
      permissionSetName: PermissionSetTable.name,
      teamId: TeamTable.id,
      teamName: TeamTable.name,
    })
      .from(PermissionSetTeamTable)
      .innerJoin(PermissionSetTable, and(
        eq(PermissionSetTable.id, PermissionSetTeamTable.permissionSetId),
        eq(PermissionSetTable.organizationId, PermissionSetTeamTable.organizationId),
      ))
      .innerJoin(TeamTable, and(
        eq(TeamTable.id, PermissionSetTeamTable.teamId),
        eq(TeamTable.organizationId, PermissionSetTeamTable.organizationId),
      ))
      .where(and(
        eq(PermissionSetTeamTable.organizationId, organizationId),
        inArray(PermissionSetTeamTable.teamId, chunk),
        isNull(PermissionSetTeamTable.removedAt),
        isNull(PermissionSetTable.archivedAt),
      ))
      .orderBy(asc(PermissionSetTeamTable.createdAt), asc(PermissionSetTeamTable.id))
    result.push(...(options.lock ? await query.for(options.lock) : await query))
  }
  return result
}

export type AuthoritativeTeamMembership = {
  memberId: MemberId
  teamId: TeamId
  teamName: string
  grantsOrganizationAdmin: boolean
}

/** What decides whether one team membership carries authority (listAuthoritativeTeamMemberships). */
export type TeamMembershipScimFacts = {
  /** A scim_group still maps this team. */
  teamHasScimGroup: boolean
  /** That group's provider's group mapping mode, or null when the provider no longer exists. */
  groupMappingMode: string | null
  /** The identity provider still lists this member in that group (a live scim_group_member link to this membership). */
  listedByIdentityProvider: boolean
  /**
   * A scim_group_member row links this membership as a SCIM projection, but its group no longer
   * exists, no longer maps this team, or its provider no longer exists.
   */
  orphanedScimProjection: boolean
}

/**
 * Whether a team membership carries authority. A membership the identity
 * provider projected stops counting once its group or provider is gone, even
 * if cleanup left the row behind. Otherwise a team no SCIM group maps counts
 * (manual teams, and teams whose SCIM provider was deleted); a mapped team
 * counts when its provider only mirrors group metadata, or creates teams and
 * still lists this member. A mapped team whose provider is missing fails closed.
 */
export function isAuthoritativeTeamMembership(facts: TeamMembershipScimFacts): boolean {
  if (facts.orphanedScimProjection) return false
  if (!facts.teamHasScimGroup) return true
  if (facts.groupMappingMode === "metadata_only") return true
  if (facts.groupMappingMode === "create_teams") return facts.listedByIdentityProvider
  return false
}

const ProjectionLinkTable = alias(ScimGroupMemberTable, "scim_projection_link")
const ProjectionGroupTable = alias(ScimGroupTable, "scim_projection_group")
const ProjectionProviderTable = alias(ScimProviderTable, "scim_projection_provider")

/**
 * Team memberships that carry authority: Admin-team status (effective admin)
 * and team permission sets (isAuthoritativeTeamMembership). A SCIM-mapped
 * team projection is not itself authority: a membership counts when the team
 * has no SCIM group, its provider only mirrors group metadata, or the provider
 * creates teams and the identity provider still lists this member in the
 * group. Orphaned projections (group or provider gone) and members added by
 * hand to an IdP-managed team fail closed. Active (not removed) members only.
 * Never cache: IdP removals and designation changes apply on the next check.
 * `lock: "share"` reads the latest committed memberships inside a transaction.
 */
export async function listAuthoritativeTeamMemberships(
  database: PermissionDatabase,
  input: { organizationId: OrganizationId; memberId?: MemberId; adminTeamsOnly?: boolean; lock?: "share" },
): Promise<AuthoritativeTeamMembership[]> {
  const { organizationId } = input
  const query = database.select({
    teamMemberId: TeamMemberTable.id,
    memberId: MemberTable.id,
    teamId: TeamTable.id,
    teamName: TeamTable.name,
    grantsOrganizationAdmin: TeamTable.grantsOrganizationAdmin,
    scimGroupId: ScimGroupTable.id,
    groupMappingMode: ScimProviderTable.groupMappingMode,
    listedMemberId: ScimGroupMemberTable.id,
    projectionLinkId: ProjectionLinkTable.id,
    projectionGroupTeamId: ProjectionGroupTable.teamId,
    projectionProviderId: ProjectionProviderTable.id,
  })
    .from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .innerJoin(MemberTable, and(
      eq(MemberTable.id, TeamMemberTable.orgMembershipId),
      eq(MemberTable.organizationId, TeamTable.organizationId),
      isNull(MemberTable.removedAt),
    ))
    .leftJoin(ScimGroupTable, and(eq(ScimGroupTable.teamId, TeamTable.id), eq(ScimGroupTable.organizationId, organizationId)))
    .leftJoin(ScimProviderTable, and(
      eq(ScimProviderTable.providerId, ScimGroupTable.providerId),
      eq(ScimProviderTable.organizationId, organizationId),
    ))
    .leftJoin(ScimGroupMemberTable, and(
      eq(ScimGroupMemberTable.groupId, ScimGroupTable.id),
      eq(ScimGroupMemberTable.providerId, ScimProviderTable.providerId),
      eq(ScimGroupMemberTable.organizationId, organizationId),
      eq(ScimGroupMemberTable.teamMemberId, TeamMemberTable.id),
      eq(ScimGroupMemberTable.orgMembershipId, MemberTable.id),
      eq(ScimGroupMemberTable.remoteUserId, MemberTable.userId),
    ))
    // Any SCIM projection link to this membership, live or not, with its own group and provider.
    .leftJoin(ProjectionLinkTable, eq(ProjectionLinkTable.teamMemberId, TeamMemberTable.id))
    .leftJoin(ProjectionGroupTable, eq(ProjectionGroupTable.id, ProjectionLinkTable.groupId))
    .leftJoin(ProjectionProviderTable, and(
      eq(ProjectionProviderTable.providerId, ProjectionGroupTable.providerId),
      eq(ProjectionProviderTable.organizationId, organizationId),
    ))
    .where(and(
      eq(TeamTable.organizationId, organizationId),
      input.memberId !== undefined ? eq(MemberTable.id, input.memberId) : undefined,
      input.adminTeamsOnly ? eq(TeamTable.grantsOrganizationAdmin, true) : undefined,
    ))
  const rows = input.lock ? await query.for(input.lock) : await query

  // The left joins can repeat a membership; fold its rows into one set of facts.
  const byMembership = new Map<string, { membership: AuthoritativeTeamMembership; facts: TeamMembershipScimFacts }>()
  for (const row of rows) {
    const entry = byMembership.get(row.teamMemberId) ?? {
      membership: { memberId: row.memberId, teamId: row.teamId, teamName: row.teamName, grantsOrganizationAdmin: row.grantsOrganizationAdmin },
      facts: { teamHasScimGroup: false, groupMappingMode: null, listedByIdentityProvider: false, orphanedScimProjection: false },
    }
    if (row.scimGroupId !== null) {
      entry.facts.teamHasScimGroup = true
      entry.facts.groupMappingMode = row.groupMappingMode
    }
    if (row.listedMemberId !== null) entry.facts.listedByIdentityProvider = true
    if (row.projectionLinkId !== null && (row.projectionGroupTeamId !== row.teamId || row.projectionProviderId === null)) {
      entry.facts.orphanedScimProjection = true
    }
    byMembership.set(row.teamMemberId, entry)
  }
  return [...byMembership.values()].flatMap(({ membership, facts }) => isAuthoritativeTeamMembership(facts) ? [membership] : [])
}

type DefaultSetRow = { id: PermissionSetId; organizationId: OrganizationId; defaultKey: PermissionDefaultSetKey }

function isDefaultSetRow(row: { id: PermissionSetId; organizationId: OrganizationId; defaultKey: PermissionDefaultSetKey | null }): row is DefaultSetRow {
  return row.defaultKey !== null
}

/**
 * Adds rows for catalog keys that are new to each default set (overview
 * section 8), for every organization's Member and Admin sets, or one
 * organization's when `organizationId` is given. Covers archived sets and
 * organizations whose feature is off. Team sets are never reconciled.
 * Idempotent: a set is only written when it has a never-seen default key, and
 * that write re-checks under a row lock. Pass the root database.
 */
export async function reconcileDefaultPermissionSets(
  database: PermissionDatabase,
  options: { organizationId?: OrganizationId; catalog?: Readonly<Record<PermissionKey, PermissionCatalogEntry>> } = {},
): Promise<ReconcilePermissionSetsResult> {
  const catalog = options.catalog ?? PERMISSIONS
  const sets = (await database.select({
    id: PermissionSetTable.id,
    organizationId: PermissionSetTable.organizationId,
    defaultKey: PermissionSetTable.defaultKey,
  })
    .from(PermissionSetTable)
    .where(options.organizationId
      ? and(isNotNull(PermissionSetTable.defaultKey), eq(PermissionSetTable.organizationId, options.organizationId))
      : isNotNull(PermissionSetTable.defaultKey))
    .orderBy(asc(PermissionSetTable.id))).filter(isDefaultSetRow)

  const result: ReconcilePermissionSetsResult = { setsChecked: sets.length, setsChanged: 0, rowsInserted: 0 }
  const decide = (set: DefaultSetRow, states: PermissionKeyStates) => reconcileDecisions({
    setDefaultKey: set.defaultKey,
    existingKeysEverSeen: new Set(states.keys()),
    currentStates: states,
    catalog,
  })

  for (const batch of chunks(sets, RECONCILE_BATCH_SIZE)) {
    const states = await readPermissionSetStates(database, batch.map((set) => set.id))
    for (const set of batch) {
      if (decide(set, states.get(set.id) ?? new Map()).length === 0) continue
      const inserted = await inTransaction(database, async (tx) => {
        if (!(await lockPermissionSet(tx, set.organizationId, set.id))) return 0
        const fresh = (await readPermissionSetStates(tx, [set.id], { lock: "share" })).get(set.id) ?? new Map()
        const decisions = decide(set, fresh)
        if (decisions.length === 0) return 0
        await tx.insert(PermissionSetPermissionTable).values(buildPermissionRows({
          organizationId: set.organizationId,
          permissionSetId: set.id,
          changes: decisions,
          source: "reconcile",
          notBefore: await latestPermissionRowCreatedAt(tx, set.id),
        }))
        return decisions.length
      })
      if (inserted > 0) {
        result.setsChanged += 1
        result.rowsInserted += inserted
      }
    }
  }
  return result
}
