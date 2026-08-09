import { describe, expect, test } from "bun:test"
import { shouldRevokeSessionsForRoleChange } from "../src/organization-role-hierarchy.js"

describe("organization role change session revocation", () => {
  test("preserves sessions only for unchanged roles and unambiguous built-in upgrades", () => {
    expect(shouldRevokeSessionsForRoleChange("member", "admin")).toBe(false)
    expect(shouldRevokeSessionsForRoleChange("member", "member")).toBe(false)

    expect(shouldRevokeSessionsForRoleChange("admin", "member")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("owner", "admin")).toBe(true)
  })

  test("fails closed for custom, multi-role, and unknown role changes", () => {
    expect(shouldRevokeSessionsForRoleChange("qa", "admin")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("admin", "admin,qa")).toBe(true)
    expect(shouldRevokeSessionsForRoleChange("garbage", "unknown")).toBe(true)
  })
})
