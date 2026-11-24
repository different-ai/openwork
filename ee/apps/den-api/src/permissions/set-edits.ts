import {
  PERMISSION_DEFAULT_SET_LABELS,
  PERMISSION_KEYS,
  getPermissionDefinition,
  isPermissionDefaultOn,
  isPermissionKey,
  isPermissionLockedOn,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"
import type { PermissionSource } from "./effective.js"

export type PermissionStatus = "allow" | "deny"

export type RequestedPermissionChange = {
  key: string
  status: PermissionStatus
}

export type PermissionChange = {
  key: PermissionKey
  status: PermissionStatus
}

export type PermissionEditor = {
  isOwner: boolean
  isSuperAdmin?: boolean
  isAdmin: boolean
  has(key: PermissionKey): boolean
}

export type PermissionEditProblem =
  | { error: "unknown_permission"; keys: string[] }
  | { error: "duplicate_permission"; keys: string[] }
  | { error: "admin_permissions_require_admin"; keys: PermissionKey[] }
  | { error: "super_admin_permissions_require_super_admin"; keys: PermissionKey[] }
  | { error: "permission_locked"; keys: PermissionKey[] }
  | { error: "permission_not_held"; keys: PermissionKey[] }

export type PermissionEditPlan =
  | { ok: true; changes: PermissionChange[] }
  | { ok: false; problem: PermissionEditProblem }

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

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

function isShippedDefault(key: PermissionKey, defaultKey: PermissionDefaultSetKey | null): boolean {
  return defaultKey !== null && isPermissionDefaultOn(getPermissionDefinition(key), defaultKey)
}

export function currentPermissionStatus(current: ReadonlyMap<string, PermissionStatus>, key: PermissionKey): PermissionStatus {
  return current.get(key) === "allow" ? "allow" : "deny"
}

export function planPermissionSetEdit(input: {
  defaultKey: PermissionDefaultSetKey | null
  current: ReadonlyMap<string, PermissionStatus>
  changes: readonly RequestedPermissionChange[]
  editor: PermissionEditor
}): PermissionEditPlan {
  const validated = validateRequestedKeys(input.changes)
  if (!validated.ok) return validated

  const { defaultKey } = input
  if (defaultKey === "admin" && !input.editor.isOwner && input.editor.isSuperAdmin !== true && !input.editor.isAdmin) {
    return { ok: false, problem: { error: "admin_permissions_require_admin", keys: sorted(validated.changes.map((change) => change.key)) } }
  }
  if (defaultKey === "super-admin" && !input.editor.isOwner && input.editor.isSuperAdmin !== true) {
    return { ok: false, problem: { error: "super_admin_permissions_require_super_admin", keys: sorted(validated.changes.map((change) => change.key)) } }
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

export function permissionEditProblemMessage(problem: PermissionEditProblem): string {
  const keys = problem.keys.join(", ")
  switch (problem.error) {
    case "unknown_permission":
      return `These permissions don't exist: ${keys}.`
    case "duplicate_permission":
      return `Each permission can appear only once. Listed more than once: ${keys}.`
    case "admin_permissions_require_admin":
      return "Only the owner and admins can change Admin permissions."
    case "super_admin_permissions_require_super_admin":
      return "Only the owner and super admins can change Super admin permissions."
    case "permission_locked":
      return `These permissions are always on for admins, so admins can't be locked out of managing permissions: ${keys}.`
    case "permission_not_held":
      return `You can only turn on permissions you have yourself. You don't have: ${keys}.`
  }
}

export type PermissionRowWithMetadata = {
  id: string
  permissionKey: string
  createdAt: Date
}

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

export function permissionKeyDelta(before: ReadonlySet<PermissionKey>, after: ReadonlySet<PermissionKey>): { granted: PermissionKey[]; revoked: PermissionKey[] } {
  return {
    granted: sorted([...after].filter((key) => !before.has(key))),
    revoked: sorted([...before].filter((key) => !after.has(key))),
  }
}

export function teamPermissionSetName(teamName: string): string {
  const suffix = " Permissions"
  return `${teamName.trim().slice(0, 255 - suffix.length)}${suffix}`
}

export function permissionSourceLabel(source: PermissionSource): string {
  switch (source.kind) {
    case "owner":
      return "Organization owner"
    case "super_admin":
      return "Super admin role"
    case "super_admin_default":
      return `${source.setName} (super admin role)`
    case "member_default":
      return source.setName
    case "admin_default":
      return source.via === "role"
        ? `${source.setName} (admin role)`
        : `${source.setName} (via ${source.teamName ?? "an admin"} team)`
    case "team":
      return `${source.setName} (via ${source.teamName} team)`
    case "direct":
      return `${source.setName} (given directly)`
    case "code_default":
      return `${PERMISSION_DEFAULT_SET_LABELS[source.set]} permissions (default)`
  }
}
