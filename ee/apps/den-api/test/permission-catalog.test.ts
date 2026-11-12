import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ASSIGNABLE_PERMISSION_DEFAULT_SET_KEYS,
  BILLING_MANAGER_PERMISSION_KEYS,
  ROLE_PERMISSION_DEFAULT_SET_KEYS,
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
 * admins (docs/permissions/route-inventory.md), plus keys for read-only
 * screens added later that admins are meant to see (billing_invoices.view:
 * the Invoices page).
 */
const ADMIN_SCOPE_KEYS = [
  "agent_permissions.view",
  "analytics.manage",
  "analytics.view",
  "api_keys.view",
  "audit.manage",
  "audit.view",
  "billing.manage",
  "billing.view",
  "billing_invoices.view",
  "computers.disconnect",
  "computers.view",
  "connections.disconnect",
  "connections.manage",
  "connections.view",
  "connectors.manage",
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
  "prompts.manage",
  "prompts.view",
  "scim.view",
  "sharing.manage_all",
  "sharing.share_org_wide",
  "sso.view",
  "teams.manage",
  "teams.view",
  "usage_analytics.view",
  "web_origins.view",
]

/** Formerly super-admin (or owner) only: nobody but the owner holds these until granted. */
const OWNER_ONLY_KEYS = [
  "agent_permissions.manage",
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
    // Neither Member nor Admin starts with it. A built-in role given on purpose (Billing manager) may.
    assert.deepEqual(getPermissionDefinition(key).defaultOn.filter((set) => set === "member" || set === "admin"), [], key)
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
  assert.equal(isPermissionSensitive("computers.disconnect"), true)
  assert.equal(isPermissionSensitive("computers.view"), false)
  assert.equal(isPermissionSensitive("billing_portal.use"), true)
  assert.equal(isPermissionSensitive("permissions.view"), false)
  assert.equal(isPermissionSensitive("connections.manage"), false)
  assert.equal(isPermissionSensitive("gateway_limits.manage"), false)
})

test("admins see invoices but can't open the billing portal by default", () => {
  assert.ok(permissionDefaultKeys("admin").includes("billing_invoices.view"))
  assert.equal(isPermissionOwnerOnlyByDefault("billing_portal.use"), true)
  assert.equal(isPermissionSensitive("billing_invoices.view"), true)
})

test("Billing manager is a built-in role with exactly the billing permissions", () => {
  assert.deepEqual([...permissionDefaultKeys("billing-manager")].sort(), ["billing.manage", "billing.view", "billing_invoices.view", "billing_portal.use", "gateway_usage.view"])
  assert.deepEqual([...BILLING_MANAGER_PERMISSION_KEYS], permissionDefaultKeys("billing-manager"))
  // The portal stays owner-only for admins: only the Billing manager role carries it.
  assert.equal(isPermissionOwnerOnlyByDefault("billing_portal.use"), true)
  assert.equal(permissionDefaultKeys("admin").includes("billing_portal.use"), false)
  // Every built-in set except Member and Admin is reached only by being given the role.
  assert.deepEqual([...ROLE_PERMISSION_DEFAULT_SET_KEYS], ["member", "admin", "super-admin"])
  assert.deepEqual([...ASSIGNABLE_PERMISSION_DEFAULT_SET_KEYS], ["billing-manager", "super-admin"])
})

test("billing manager keys stay inside billing and usage", () => {
  for (const key of BILLING_MANAGER_PERMISSION_KEYS) {
    assert.ok(isPermissionKey(key), key)
    assert.ok(["billing", "gateway"].includes(getPermissionDefinition(key).area), key)
  }
  for (const excluded of ["members.update", "members.delete", "invitations.manage", "teams.manage", "teams.manage_admin", "permissions.manage", "connections.manage", "connectors.manage", "sso.manage", "scim.manage", "api_keys.manage", "organization.update"]) {
    assert.equal((BILLING_MANAGER_PERMISSION_KEYS as readonly string[]).includes(excluded), false, excluded)
  }
})

test("schema accepts catalog keys only", () => {
  assert.equal(permissionKeySchema.safeParse("permissions.view").success, true)
  assert.equal(permissionKeySchema.safeParse("permissions.unknown").success, false)
})
