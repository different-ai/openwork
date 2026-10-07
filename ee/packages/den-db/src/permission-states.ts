import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  PERMISSION_KEYS,
  type PermissionDefaultSetKey,
  type PermissionDefinition,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import type { PermissionChangeSource, PermissionSetPermissionTable, PermissionSetTable, PermissionStatus } from "./schema/permissions"

/**
 * Pure permission state helpers (no database). Imported by permissions.ts and
 * re-exported from it; also importable on its own as
 * `@openwork-ee/den-db/permission-states` (e.g. from plain Node tests).
 * See docs/permissions/overview.md, sections 5 and 8.
 */

type OrganizationId = typeof PermissionSetTable.$inferSelect.organizationId
type PermissionSetId = typeof PermissionSetTable.$inferSelect.id
type OrgMembershipId = NonNullable<typeof PermissionSetPermissionTable.$inferSelect.changedByOrgMembershipId>

/** One stored permission row, as needed to compute current state. */
export type PermissionHistoryRow<TSetId extends string = string> = {
  id: string
  permissionSetId: TSetId
  permissionKey: string
  status: PermissionStatus
  createdAt: Date
}

/** Current status per key for one set, including keys no longer in the catalog. */
export type PermissionKeyStates = ReadonlyMap<string, PermissionStatus>

/** Later by created_at, then by id (TypeIDs are UUIDv7, so id order is time order). */
function isLaterPermissionRow(candidate: PermissionHistoryRow, current: PermissionHistoryRow) {
  const difference = candidate.createdAt.getTime() - current.createdAt.getTime()
  if (difference !== 0) return difference > 0
  return candidate.id > current.id
}

/**
 * Current status per (set, key): the latest row by (createdAt, id). Every key
 * that has ever had a row appears, including keys no longer in the catalog,
 * so the key set doubles as "keys ever seen" for reconciliation.
 */
export function currentPermissionStates<TSetId extends string>(
  rows: Iterable<PermissionHistoryRow<TSetId>>,
): Map<TSetId, Map<string, PermissionStatus>> {
  const latest = new Map<TSetId, Map<string, PermissionHistoryRow<TSetId>>>()
  for (const row of rows) {
    let bySet = latest.get(row.permissionSetId)
    if (!bySet) {
      bySet = new Map()
      latest.set(row.permissionSetId, bySet)
    }
    const current = bySet.get(row.permissionKey)
    if (!current || isLaterPermissionRow(row, current)) bySet.set(row.permissionKey, row)
  }

  const states = new Map<TSetId, Map<string, PermissionStatus>>()
  for (const [setId, bySet] of latest) {
    states.set(setId, new Map([...bySet].map(([key, row]) => [key, row.status])))
  }
  return states
}

/** Keys whose current status is allow and that are still in the catalog. No row means denied. */
export function allowedKeys(
  states: PermissionKeyStates | undefined,
  catalogKeys: readonly PermissionKey[] = PERMISSION_KEYS,
): Set<PermissionKey> {
  const allowed = new Set<PermissionKey>()
  if (!states) return allowed
  for (const key of catalogKeys) {
    if (states.get(key) === "allow") allowed.add(key)
  }
  return allowed
}

export type PermissionCatalogEntry = Pick<PermissionDefinition, "defaultOn" | "follows">

export type PermissionDecision<TKey extends string = PermissionKey> = {
  key: TKey
  status: PermissionStatus
}

/**
 * Rows reconciliation should insert into one default set (overview section 8).
 * For each catalog key whose `defaultOn` includes the set's default key and
 * that has never had a row in the set: deny when it `follows` a key that is
 * not allowed in the set, otherwise allow. Explicit choices (any existing
 * row, allow or deny) are never touched. Keys added in the same pass are
 * decided in dependency order, so a new key can follow another new key.
 */
export function reconcileDecisions<TKey extends string>(input: {
  setDefaultKey: PermissionDefaultSetKey
  existingKeysEverSeen: ReadonlySet<string>
  currentStates: PermissionKeyStates
  catalog: Readonly<Record<TKey, PermissionCatalogEntry>>
}): PermissionDecision<TKey>[] {
  const { catalog } = input
  const catalogKeys = Object.keys(catalog).filter((key): key is TKey => Object.prototype.hasOwnProperty.call(catalog, key))
  const candidates = catalogKeys.filter((key) =>
    catalog[key].defaultOn.includes(input.setDefaultKey) && !input.existingKeysEverSeen.has(key))
  const candidateByKey = new Map<string, TKey>(candidates.map((key) => [key, key]))

  const working = new Map<string, PermissionStatus>(input.currentStates)
  const decided = new Set<string>()
  const visiting = new Set<string>()
  const decisions: PermissionDecision<TKey>[] = []

  const decide = (key: TKey) => {
    if (decided.has(key) || visiting.has(key)) return
    visiting.add(key)
    const follows = catalog[key].follows
    const pendingTarget = follows === undefined ? undefined : candidateByKey.get(follows)
    if (pendingTarget !== undefined) decide(pendingTarget)
    const status: PermissionStatus = follows !== undefined && working.get(follows) !== "allow" ? "deny" : "allow"
    visiting.delete(key)
    decided.add(key)
    working.set(key, status)
    decisions.push({ key, status })
  }

  for (const key of candidates) decide(key)
  return decisions
}

/**
 * `createdAt` for new rows of a set: `now`, but at least 1ms after the set's
 * latest existing row, so new rows sort after it by (created_at, id) even if
 * the clock moved backwards or another host's clock runs ahead.
 */
export function monotonicPermissionRowTime(now: Date, notBefore: Date | null | undefined): Date {
  if (!notBefore) return now
  return new Date(Math.max(now.getTime(), notBefore.getTime() + 1))
}

/**
 * Row values for inserting permission changes. Use this for every insert so
 * rows get millisecond `createdAt` from the same clock as their UUIDv7 ids.
 * Pass `notBefore` (the set's latest existing row time, read under
 * lockPermissionSet) so the new rows become the set's current state.
 */
export function buildPermissionRows(input: {
  organizationId: OrganizationId
  permissionSetId: PermissionSetId
  changes: readonly PermissionDecision<string>[]
  source: PermissionChangeSource
  changedByOrgMembershipId?: OrgMembershipId | null
  now?: Date
  notBefore?: Date | null
}): (typeof PermissionSetPermissionTable.$inferInsert)[] {
  const createdAt = monotonicPermissionRowTime(input.now ?? new Date(), input.notBefore)
  return input.changes.map((change) => ({
    id: createDenTypeId("permissionSetPermission"),
    organizationId: input.organizationId,
    permissionSetId: input.permissionSetId,
    permissionKey: change.key,
    status: change.status,
    source: input.source,
    changedByOrgMembershipId: input.changedByOrgMembershipId ?? null,
    createdAt,
  }))
}

/**
 * Thrown by ensureDefaultPermissionSets when the Member or Admin default set
 * still does not exist after trying to create it. Resolution treats only this
 * as "fall back to code defaults"; every other error fails closed.
 */
export class DefaultPermissionSetsMissingError extends Error {
  readonly code = "default_permission_sets_missing"
  readonly organizationId: string

  constructor(organizationId: string) {
    super(`Default permission sets are missing for organization ${organizationId}`)
    this.name = "DefaultPermissionSetsMissingError"
    this.organizationId = organizationId
  }
}

export function isDefaultPermissionSetsMissingError(error: unknown): error is DefaultPermissionSetsMissingError {
  return error instanceof DefaultPermissionSetsMissingError
    || (typeof error === "object" && error !== null
      && "code" in error && error.code === "default_permission_sets_missing"
      && "name" in error && error.name === "DefaultPermissionSetsMissingError")
}
