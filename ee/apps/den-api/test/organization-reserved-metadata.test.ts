import assert from "node:assert/strict"
import { test } from "node:test"
import { findReservedOrganizationMetadataKey } from "../src/organization-reserved-metadata.js"

test("organization creation cannot set platform-admin entitlements", () => {
  for (const key of ["dpaSigned", "plan", "limits", "seatsFreeAdditional", "inference", "inferenceFree"]) {
    assert.equal(findReservedOrganizationMetadataKey({ brandAppName: "Example Workspace", [key]: true }), key)
  }
})

test("organization creation keeps ordinary metadata", () => {
  assert.equal(findReservedOrganizationMetadataKey({}), null)
  assert.equal(findReservedOrganizationMetadataKey({ brandAppName: "Example Workspace" }), null)
})
