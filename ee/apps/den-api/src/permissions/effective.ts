import {
  PERMISSION_KEYS,
  getPermissionDefinition,
  isPermissionOwnerOnlyByDefault,
  permissionDefaultKeys,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"

export type MemberPermissions = {
  featureEnabled: true
  isOwner: boolean
  isSuperAdmin: boolean
  isAdmin: boolean
  keys: ReadonlySet<PermissionKey>
  has(key: PermissionKey): boolean
}

export type PermissionSource =
  | { kind: "owner" }
  | { kind: "super_admin" }
  | { kind: "super_admin_default"; setId: string; setName: string }
  | { kind: "member_default"; setId: string; setName: string }
  | { kind: "admin_default"; setId: string; setName: string; via: "role" | "team"; teamId?: string; teamName?: string }
  | { kind: "team"; setId: string; setName: string; teamId: string; teamName: string }
  | { kind: "direct"; setId: string; setName: string }
  | { kind: "code_default"; set: PermissionDefaultSetKey }

export type PermissionGrant = {
  source: PermissionSource
  keys: ReadonlySet<PermissionKey>
}

export type PermissionExplanation = {
  key: PermissionKey
  sources: PermissionSource[]
}

export function allPermissionKeys(): PermissionKey[] {
  return sortedPermissionKeys(PERMISSION_KEYS)
}

export function sortedPermissionKeys(keys: Iterable<PermissionKey>): PermissionKey[] {
  return [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function ownerPermissionGrants(): PermissionGrant[] {
  return [{ source: { kind: "owner" }, keys: new Set(PERMISSION_KEYS) }]
}

export function codeDefaultPermissionGrants(input: { isAdmin: boolean; isSuperAdmin?: boolean }): PermissionGrant[] {
  const grants: PermissionGrant[] = [{ source: { kind: "code_default", set: "member" }, keys: new Set(permissionDefaultKeys("member")) }]
  if (input.isAdmin || input.isSuperAdmin === true) grants.push({ source: { kind: "code_default", set: "admin" }, keys: new Set(permissionDefaultKeys("admin")) })
  if (input.isSuperAdmin === true) grants.push({ source: { kind: "code_default", set: "super-admin" }, keys: new Set(permissionDefaultKeys("super-admin")) })
  return grants
}

export function missingDefaultSetsPermissionGrants(input: { isAdmin: boolean; isSuperAdmin?: boolean; transaction: boolean }): PermissionGrant[] {
  return input.transaction ? [] : codeDefaultPermissionGrants({ isAdmin: input.isAdmin, isSuperAdmin: input.isSuperAdmin })
}

export function createMemberPermissions(input: {
  isOwner: boolean
  isSuperAdmin?: boolean
  isAdmin: boolean
  keys: Iterable<PermissionKey>
}): MemberPermissions {
  const isSuperAdmin = !input.isOwner && input.isSuperAdmin === true
  const keys: ReadonlySet<PermissionKey> = new Set(input.isOwner ? PERMISSION_KEYS : input.keys)
  return {
    featureEnabled: true,
    isOwner: input.isOwner,
    isSuperAdmin,
    isAdmin: input.isAdmin || isSuperAdmin,
    keys,
    has: (key) => keys.has(key),
  }
}

export function memberPermissionsFromGrants(input: {
  isOwner: boolean
  isSuperAdmin?: boolean
  isAdmin: boolean
  grants: readonly PermissionGrant[]
}): MemberPermissions {
  const keys = new Set<PermissionKey>()
  for (const grant of input.grants) {
    for (const key of grant.keys) keys.add(key)
  }
  return createMemberPermissions({ ...input, keys })
}

export function explainPermissionGrants(grants: readonly PermissionGrant[]): PermissionExplanation[] {
  const sourcesByKey = new Map<PermissionKey, PermissionSource[]>()
  for (const grant of grants) {
    for (const key of grant.keys) {
      const sources = sourcesByKey.get(key) ?? []
      sources.push(grant.source)
      sourcesByKey.set(key, sources)
    }
  }
  return sortedPermissionKeys(sourcesByKey.keys()).map((key) => ({ key, sources: sourcesByKey.get(key) ?? [] }))
}

function lowerFirst(value: string) {
  const second = value.charAt(1)
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return value
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`
}

export function permissionDeniedMessage(key: PermissionKey): string {
  const action = `You don't have permission to ${lowerFirst(getPermissionDefinition(key).label)}.`
  return isPermissionOwnerOnlyByDefault(key) ? `${action} Ask the organization owner.` : `${action} Ask an admin to change your permissions.`
}
