import assert from "node:assert/strict"
import { test } from "node:test"
import {
  PERMISSION_KEYS,
  PERMISSIONS,
  getPermissionDefinition,
  isPermissionKey,
  isPermissionLockedOn,
  isPermissionOwnerOnlyByDefault,
  isPermissionSensitive,
  permissionCatalogProblems,
  permissionDefaultKeys,
  permissionKeySchema,
} from "@openwork/types/den/permissions"

test("permission catalog invariants hold", () => {
  assert.deepEqual(permissionCatalogProblems(), [])
})

test("every key is <resource>.<action> in lower snake case", () => {
  for (const key of PERMISSION_KEYS) assert.match(key, /^[a-z_]+\.[a-z_]+$/)
})

test("follows always names another existing key", () => {
  for (const key of PERMISSION_KEYS) {
    const follows = getPermissionDefinition(key).follows
    if (follows === undefined) continue
    assert.ok(isPermissionKey(follows), `${key} follows unknown ${follows}`)
    assert.notEqual(follows, key)
  }
})

test("locked keys are also default on for that set", () => {
  for (const key of PERMISSION_KEYS) {
    if (isPermissionLockedOn(key, "admin")) assert.ok(permissionDefaultKeys("admin").includes(key), key)
  }
})

test("no key is locked on: the owner can always restore access", () => {
  for (const key of PERMISSION_KEYS) assert.equal(isPermissionLockedOn(key, "admin"), false, key)
})

/**
 * "Admin === admin": admins keep exactly what plain admins could do before
 * Permissions. Every key here gates only actions the old code allowed to
 * admins (docs/permissions/route-inventory.md).
 */
const ADMIN_SCOPE_KEYS = [
  "analytics.manage",
  "analytics.view",
  "api_keys.view",
  "audit.manage",
  "audit.view",
  "billing.manage",
  "billing.view",
  "connections.disconnect",
  "connections.manage",
  "connections.view",
  "connectors.manage",
  "dashboards.manage",
  "dashboards.view",
  "deployments.view",
  "desktop_policies.view",
  "egress_diagnostics.view",
  "gateway_limits.manage",
  "gateway_limits.view",
  "gateway_providers.manage",
  "gateway_providers.view",
  "gateway_usage.view",
  "inference.manage",
  "inference.view",
  "install_links.update",
  "invitations.manage",
  "llm_provider_credentials.manage",
  "llm_providers.delete",
  "llm_providers.update",
  "llm_providers.view",
  "marketplaces.manage",
  "members.delete",
  "oauth_clients.manage",
  "oauth_clients.view",
  "permissions.view",
  "plugins.import",
  "scim.view",
  "sharing.manage_all",
  "sharing.share_org_wide",
  "sso.view",
  "teams.manage",
  "teams.view",
  "web_origins.view",
]

/** Formerly super-admin (or owner) only: nobody but the owner holds these until granted. */
const OWNER_ONLY_KEYS = [
  "api_keys.manage",
  "billing_portal.use",
  "branding.update",
  "connections.delete",
  "connections.update",
  "deployments.manage",
  "desktop_policies.manage",
  "egress_diagnostics.manage",
  "members.update",
  "organization.update",
  "permissions.manage",
  "scim.manage",
  "sso.manage",
  "teams.manage_admin",
  "web_origins.manage",
]

test("admin defaults are exactly the old admin scope", () => {
  assert.deepEqual([...permissionDefaultKeys("admin")].sort(), ADMIN_SCOPE_KEYS)
})

test("former super-admin actions are owner-only by default", () => {
  for (const key of OWNER_ONLY_KEYS) {
    assert.ok(isPermissionKey(key), key)
    assert.deepEqual(getPermissionDefinition(key).defaultOn, [], key)
    assert.equal(isPermissionOwnerOnlyByDefault(key), true, key)
  }
  assert.deepEqual([...ADMIN_SCOPE_KEYS, ...OWNER_ONLY_KEYS].sort(), [...PERMISSION_KEYS].sort())
})

test("members hold nothing by default", () => {
  assert.deepEqual(permissionDefaultKeys("member"), [])
})

test("recent sign-in matches the old freshness rules", () => {
  assert.equal(PERMISSIONS["permissions.manage"].sensitive, true)
  assert.equal(isPermissionSensitive("llm_provider_credentials.manage"), true)
  assert.equal(isPermissionSensitive("connections.disconnect"), true)
  assert.equal(isPermissionSensitive("billing_portal.use"), true)
  assert.equal(isPermissionSensitive("permissions.view"), false)
  assert.equal(isPermissionSensitive("connections.manage"), false)
  assert.equal(isPermissionSensitive("gateway_limits.manage"), false)
})

test("schema accepts catalog keys only", () => {
  assert.equal(permissionKeySchema.safeParse("permissions.view").success, true)
  assert.equal(permissionKeySchema.safeParse("permissions.unknown").success, false)
})
