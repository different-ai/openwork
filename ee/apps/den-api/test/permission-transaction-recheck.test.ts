import assert from "node:assert/strict"
import { test } from "node:test"
import { permissionDefaultKeys } from "@openwork/types/den/permissions"
import {
  codeDefaultPermissionGrants,
  memberPermissionsFromGrants,
  missingDefaultSetsPermissionGrants,
} from "../src/permissions/effective.ts"

test("missing default sets fall back to code defaults outside a transaction", () => {
  for (const isAdmin of [false, true]) {
    assert.deepEqual(
      missingDefaultSetsPermissionGrants({ isAdmin, transaction: false }),
      codeDefaultPermissionGrants({ isAdmin }),
    )
  }
})

test("missing default sets deny everything inside a transaction, even for admins", () => {
  for (const isAdmin of [false, true]) {
    const grants = missingDefaultSetsPermissionGrants({ isAdmin, transaction: true })
    assert.deepEqual(grants, [])
    const permissions = memberPermissionsFromGrants({ featureEnabled: true, isOwner: false, isAdmin, grants })
    assert.equal(permissions.keys.size, 0)
    for (const key of permissionDefaultKeys("admin")) assert.equal(permissions.has(key), false, key)
  }
})
