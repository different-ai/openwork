import { describe, expect, test } from "bun:test"
import { verifyOrgRole } from "../src/middleware/route-access.js"
import { isProtectedOrganizationRoleName, organizationRoleValueSatisfies } from "../src/organization-role-hierarchy.js"

describe("organization role hierarchy", () => {
  test("owner satisfies owner, super-admin, and admin gates", () => {
    const userContext = { role: "owner", isOwner: true }

    expect(verifyOrgRole({ roles: ["owner"], userContext })).toBe(true)
    expect(verifyOrgRole({ roles: ["super-admin"], userContext })).toBe(true)
    expect(verifyOrgRole({ roles: ["admin"], userContext })).toBe(true)
  })

  test("super-admin satisfies super-admin and admin gates but not owner", () => {
    const userContext = { role: "super-admin", isOwner: false }

    expect(verifyOrgRole({ roles: ["owner"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["super-admin"], userContext })).toBe(true)
    expect(verifyOrgRole({ roles: ["admin"], userContext })).toBe(true)
  })

  test("admin satisfies only admin-level gates", () => {
    const userContext = { role: "admin", isOwner: false }

    expect(verifyOrgRole({ roles: ["owner"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["super-admin"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["admin"], userContext })).toBe(true)
  })

  test("plain members satisfy member gates only", () => {
    const userContext = { role: "member", isOwner: false }

    expect(verifyOrgRole({ roles: ["owner"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["super-admin"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["admin"], userContext })).toBe(false)
    expect(verifyOrgRole({ roles: ["member"], userContext })).toBe(true)
  })

  test("isOwner context upgrades stale owner role strings", () => {
    expect(organizationRoleValueSatisfies({
      roleValue: "member",
      requiredRole: "owner",
      isOwner: true,
    })).toBe(true)
  })

  test("built-in role names are protected", () => {
    expect(isProtectedOrganizationRoleName("owner")).toBe(true)
    expect(isProtectedOrganizationRoleName("super-admin")).toBe(true)
    expect(isProtectedOrganizationRoleName("admin")).toBe(true)
    expect(isProtectedOrganizationRoleName("member")).toBe(true)
    expect(isProtectedOrganizationRoleName("billing-admin")).toBe(false)
  })
})
