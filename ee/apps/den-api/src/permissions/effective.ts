import {
  PERMISSION_KEYS,
  getPermissionDefinition,
  isPermissionOwnerOnlyByDefault,
  permissionDefaultKeys,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions"

/**
 * Pure permission resolution: no database, no environment, and no relative
 * runtime imports, so plain `node --test` can load it. resolve.ts gathers the
 * inputs; effective admin status is `isEffectiveOrganizationAdmin` in
 * organization-role-hierarchy.ts. See docs/permissions/overview.md, sections 3 and 6.
 */

/** Effective permissions for one member in one organization. */
export type MemberPermissions = {
  /** Whether the organization's Permissions feature is on (database) or off (code defaults). */
  featureEnabled: boolean
  isOwner: boolean
  /** Effective admin: direct admin role (or legacy super-admin) or a member of an Admin team. */
  isAdmin: boolean
  keys: ReadonlySet<PermissionKey>
  has(key: PermissionKey): boolean
}

/** Why a member holds a permission. */
export type PermissionSource =
  | { kind: "owner" }
  | { kind: "member_default"; setId: string; setName: string }
  | { kind: "admin_default"; setId: string; setName: string; via: "role" | "team"; teamId?: string; teamName?: string }
  | { kind: "team"; setId: string; setName: string; teamId: string; teamName: string }
  | { kind: "code_default"; set: PermissionDefaultSetKey }

/** One source and the keys it allows. A member's permissions are the union over their grants. */
export type PermissionGrant = {
  source: PermissionSource
  keys: ReadonlySet<PermissionKey>
}

export type PermissionExplanation = {
  key: PermissionKey
  sources: PermissionSource[]
}

/** Every catalog key, sorted. What the owner holds; the API never sends a wildcard. */
export function allPermissionKeys(): PermissionKey[] {
  return sortedPermissionKeys(PERMISSION_KEYS)
}

export function sortedPermissionKeys(keys: Iterable<PermissionKey>): PermissionKey[] {
  return [...new Set(keys)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function ownerPermissionGrants(): PermissionGrant[] {
  return [{ source: { kind: "owner" }, keys: new Set(PERMISSION_KEYS) }]
}

/** Feature off (or a database fallback): Member code defaults, plus Admin code defaults for admins. */
export function codeDefaultPermissionGrants(input: { isAdmin: boolean }): PermissionGrant[] {
  const grants: PermissionGrant[] = [{ source: { kind: "code_default", set: "member" }, keys: new Set(permissionDefaultKeys("member")) }]
  if (input.isAdmin) grants.push({ source: { kind: "code_default", set: "admin" }, keys: new Set(permissionDefaultKeys("admin")) })
  return grants
}

/**
 * The organization's default permission sets are missing (they should always
 * exist). Outside a transaction resolution falls back to the code defaults so
 * the organization is not locked out; inside a write transaction, where sets
 * can't be created, it denies everything.
 */
export function missingDefaultSetsPermissionGrants(input: { isAdmin: boolean; transaction: boolean }): PermissionGrant[] {
  return input.transaction ? [] : codeDefaultPermissionGrants({ isAdmin: input.isAdmin })
}

export function createMemberPermissions(input: {
  featureEnabled: boolean
  isOwner: boolean
  isAdmin: boolean
  keys: Iterable<PermissionKey>
}): MemberPermissions {
  const keys: ReadonlySet<PermissionKey> = new Set(input.isOwner ? PERMISSION_KEYS : input.keys)
  return {
    featureEnabled: input.featureEnabled,
    isOwner: input.isOwner,
    isAdmin: input.isAdmin,
    keys,
    has: (key) => keys.has(key),
  }
}

/** Union of grants: a permission is allowed when any grant allows it. */
export function memberPermissionsFromGrants(input: {
  featureEnabled: boolean
  isOwner: boolean
  isAdmin: boolean
  grants: readonly PermissionGrant[]
}): MemberPermissions {
  const keys = new Set<PermissionKey>()
  for (const grant of input.grants) {
    for (const key of grant.keys) keys.add(key)
  }
  return createMemberPermissions({ ...input, keys })
}

/** Each allowed key with every source that allows it, sorted by key. */
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
  // Keep acronyms ("SSO ...") intact.
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return value
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`
}

/** The human 403 message for a missing permission, from its catalog label. */
export function permissionDeniedMessage(key: PermissionKey): string {
  const action = `You don't have permission to ${lowerFirst(getPermissionDefinition(key).label)}.`
  return isPermissionOwnerOnlyByDefault(key) ? `${action} Ask the organization owner.` : `${action} Ask an admin to change your permissions.`
}
