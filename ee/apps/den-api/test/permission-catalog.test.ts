import assert from "node:assert/strict"
import { test } from "node:test"
import {
  PERMISSION_KEYS,
  PERMISSIONS,
  getPermissionDefinition,
  isPermissionKey,
  isPermissionLockedOn,
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

test("permission management cannot be locked away from admins", () => {
  assert.equal(isPermissionLockedOn("permissions.manage", "admin"), true)
  assert.equal(PERMISSIONS["permissions.manage"].sensitive, true)
  assert.ok(permissionDefaultKeys("admin").includes("sharing.manage_all"))
})

test("admin defaults cover every catalog key while super-admin is merged into admin", () => {
  assert.deepEqual([...permissionDefaultKeys("admin")].sort(), [...PERMISSION_KEYS].sort())
})

test("schema accepts catalog keys only", () => {
  assert.equal(permissionKeySchema.safeParse("permissions.view").success, true)
  assert.equal(permissionKeySchema.safeParse("permissions.unknown").success, false)
})
