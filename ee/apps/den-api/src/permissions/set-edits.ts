import {
  PERMISSION_KEYS,
  getPermissionDefinition,
  isPermissionKey,
  isPermissionLockedOn,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import type { PermissionSource } from "./effective.js"

/**
 * Pure validation for the permission set endpoints (routes/org/permissions.ts;
 * docs/permissions/overview.md, sections 8 and 9). No database, no environment
 * and no relative runtime imports, so plain `node --test` can load it.
 */

export type PermissionStatus = "allow" | "deny"

export type RequestedPermissionChange = {
  key: string
  status: PermissionStatus
}

export type PermissionChange = {
  key: PermissionKey
  status: PermissionStatus
}

/** The editor's effective permissions. The owner holds every key. */
export type PermissionEditor = {
  isOwner: boolean
  /** Effective admin: a direct admin role or a member of an Admin team. */
  isAdmin: boolean
  has(key: PermissionKey): boolean
}

export type PermissionEditProblem =
  | { error: "unknown_permission"; keys: string[] }
  | { error: "duplicate_permission"; keys: string[] }
  | { error: "admin_permissions_require_admin"; keys: PermissionKey[] }
  | { error: "permission_locked"; keys: PermissionKey[] }
  | { error: "permission_not_held"; keys: PermissionKey[] }

export type PermissionEditPlan =
  | { ok: true; changes: PermissionChange[] }
  | { ok: false; problem: PermissionEditProblem }

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** Rejects keys outside the catalog and keys listed more than once. */
function validateRequestedKeys(changes: readonly RequestedPermissionChange[]):
  | { ok: true; changes: PermissionChange[] }
  | { ok: false; problem: PermissionEditProblem } {
  const unknown = changes.map((change) => change.key).filter((key) => !isPermissionKey(key))
  if (unknown.length > 0) return { ok: false, problem: { error: "unknown_permission", keys: sorted(unknown) } }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const valid: PermissionChange[] = []
  for (const change of changes) {
    if (!isPermissionKey(change.key)) continue
    if (seen.has(change.key)) duplicates.add(change.key)
    seen.add(change.key)
    valid.push({ key: change.key, status: change.status })
  }
  if (duplicates.size > 0) return { ok: false, problem: { error: "duplicate_permission", keys: sorted(duplicates) } }
  return { ok: true, changes: valid }
}

function notHeld(editor: PermissionEditor, keys: Iterable<PermissionKey>): PermissionKey[] {
  if (editor.isOwner) return []
  return sorted([...keys].filter((key) => !editor.has(key)))
}

/** Whether `key` starts on in this default set (its catalog `defaultOn` includes it). */
function isShippedDefault(key: PermissionKey, defaultKey: PermissionDefaultSetKey | null): boolean {
  return defaultKey !== null && getPermissionDefinition(key).defaultOn.includes(defaultKey)
}

/** Current status of a key in a set: no row means denied. */
export function currentPermissionStatus(current: ReadonlyMap<string, PermissionStatus>, key: PermissionKey): PermissionStatus {
  return current.get(key) === "allow" ? "allow" : "deny"
}

/**
 * Plans an edit to an existing set (PUT /v1/permissions/sets/:id/permissions).
 * In order: unknown keys, duplicate keys, any edit to Admin permissions by an
 * editor who is neither the owner nor an effective admin, deny of a key locked
 * on for this default set, then allow of a key the editor does not hold (only
 * where the key is actually being turned on, so resending a set's current
 * state never fails). Re-allowing a key whose catalog `defaultOn` includes
 * this default set restores a shipped default and is exempt from the
 * hold-the-key rule, so admins can restore an Admin key they removed.
 * Returns only the changes whose status differs from the current one, in
 * request order.
 */
export function planPermissionSetEdit(input: {
  defaultKey: PermissionDefaultSetKey | null
  current: ReadonlyMap<string, PermissionStatus>
  changes: readonly RequestedPermissionChange[]
  editor: PermissionEditor
}): PermissionEditPlan {
  const validated = validateRequestedKeys(input.changes)
  if (!validated.ok) return validated

  const { defaultKey } = input
  if (defaultKey === "admin" && !input.editor.isOwner && !input.editor.isAdmin) {
    return { ok: false, problem: { error: "admin_permissions_require_admin", keys: sorted(validated.changes.map((change) => change.key)) } }
  }

  const locked = defaultKey === null
    ? []
    : validated.changes.filter((change) => change.status === "deny" && isPermissionLockedOn(change.key, defaultKey)).map((change) => change.key)
  if (locked.length > 0) return { ok: false, problem: { error: "permission_locked", keys: sorted(locked) } }

  const changes = validated.changes.filter((change) => currentPermissionStatus(input.current, change.key) !== change.status)
  const turningOn = changes
    .filter((change) => change.status === "allow" && !isShippedDefault(change.key, defaultKey))
    .map((change) => change.key)
  const missing = notHeld(input.editor, turningOn)
  if (missing.length > 0) return { ok: false, problem: { error: "permission_not_held", keys: missing } }

  return { ok: true, changes }
}

/**
 * Plans the initial rows of a new team set (POST /v1/permissions/sets). Only
 * allowed keys get a row (no row means denied). The editor must hold every
 * key the new set allows.
 */
export function planPermissionSetCreate(input: {
  permissions: readonly RequestedPermissionChange[]
  editor: PermissionEditor
}): PermissionEditPlan {
  const validated = validateRequestedKeys(input.permissions)
  if (!validated.ok) return validated

  const changes = validated.changes.filter((change) => change.status === "allow")
  const missing = notHeld(input.editor, changes.map((change) => change.key))
  if (missing.length > 0) return { ok: false, problem: { error: "permission_not_held", keys: missing } }
  return { ok: true, changes }
}

/** Human message for a rejected edit. */
export function permissionEditProblemMessage(problem: PermissionEditProblem): string {
  const keys = problem.keys.join(", ")
  switch (problem.error) {
    case "unknown_permission":
      return `These permissions don't exist: ${keys}.`
    case "duplicate_permission":
      return `Each permission can appear only once. Listed more than once: ${keys}.`
    case "admin_permissions_require_admin":
      return "Only the owner and admins can change Admin permissions."
    case "permission_locked":
      return `These permissions are always on for admins, so admins can't be locked out of managing permissions: ${keys}.`
    case "permission_not_held":
      return `You can only turn on permissions you have yourself. You don't have: ${keys}.`
  }
}

/** One stored row with the metadata the endpoints show. */
export type PermissionRowWithMetadata = {
  id: string
  permissionKey: string
  createdAt: Date
}

/**
 * The latest row per key by (createdAt, id), the same order as
 * currentPermissionStates in den-db. Includes keys no longer in the catalog.
 */
export function latestPermissionRows<Row extends PermissionRowWithMetadata>(rows: Iterable<Row>): Map<string, Row> {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    const current = latest.get(row.permissionKey)
    if (!current) {
      latest.set(row.permissionKey, row)
      continue
    }
    const difference = row.createdAt.getTime() - current.createdAt.getTime()
    if (difference > 0 || (difference === 0 && row.id > current.id)) latest.set(row.permissionKey, row)
  }
  return latest
}

export type PermissionKeyState<Row> = {
  key: PermissionKey
  status: PermissionStatus
  locked: boolean
  latest: Row | null
}

/** Status of every catalog key in a set, in catalog order, with its latest row and lock flag. */
export function permissionSetKeyStates<Row extends PermissionRowWithMetadata & { status: PermissionStatus }>(input: {
  defaultKey: PermissionDefaultSetKey | null
  rows: Iterable<Row>
}): PermissionKeyState<Row>[] {
  const latest = latestPermissionRows(input.rows)
  const { defaultKey } = input
  return PERMISSION_KEYS.map((key) => {
    const row = latest.get(key) ?? null
    return {
      key,
      status: row?.status === "allow" ? "allow" : "deny",
      locked: defaultKey !== null && isPermissionLockedOn(key, defaultKey),
      latest: row,
    }
  })
}

/** Keys allowed in `after` but not `before`, and the reverse. */
export function permissionKeyDelta(before: ReadonlySet<PermissionKey>, after: ReadonlySet<PermissionKey>): { granted: PermissionKey[]; revoked: PermissionKey[] } {
  return {
    granted: sorted([...after].filter((key) => !before.has(key))),
    revoked: sorted([...before].filter((key) => !after.has(key))),
  }
}

/** The name of a new team set, fixed forever: "${team.name} Permissions", within the 255-character column. */
export function teamPermissionSetName(teamName: string): string {
  const suffix = " Permissions"
  return `${teamName.trim().slice(0, 255 - suffix.length)}${suffix}`
}

/** The user-facing label of a permission source, e.g. "Admin permissions (admin role)". */
export function permissionSourceLabel(source: PermissionSource): string {
  switch (source.kind) {
    case "owner":
      return "Organization owner"
    case "member_default":
      return source.setName
    case "admin_default":
      return source.via === "role"
        ? `${source.setName} (admin role)`
        : `${source.setName} (via ${source.teamName ?? "an admin"} team)`
    case "team":
      return `${source.setName} (via ${source.teamName} team)`
    case "code_default":
      return source.set === "admin" ? "Admin permissions (default)" : "Member permissions (default)"
  }
}
