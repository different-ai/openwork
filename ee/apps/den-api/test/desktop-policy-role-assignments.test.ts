import { describe, expect, test } from "bun:test"
import { matchingDesktopPolicyAssignmentRoles } from "../src/desktop-policy-role-assignments.js"

describe("desktop policy role assignments", () => {
  test("matches role assignments through the organization hierarchy", () => {
    expect(matchingDesktopPolicyAssignmentRoles("owner")).toEqual(["owner", "admin", "member"])
    expect(matchingDesktopPolicyAssignmentRoles("super-admin")).toEqual(["admin", "member"])
    expect(matchingDesktopPolicyAssignmentRoles("admin,member")).toEqual(["admin", "member"])
    expect(matchingDesktopPolicyAssignmentRoles("member")).toEqual(["member"])
  })
})
