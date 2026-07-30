import { describe, expect, test } from "bun:test"
import {
  canManageSecurityConfiguration,
  denDefaultDynamicOrganizationRoles,
  denOrganizationStaticRoles,
  resolveOrganizationPermissionRecord,
  type OrganizationPermissionRecord,
} from "../src/organization-access.js"

function actions(permission: OrganizationPermissionRecord, resource: string) {
  return permission[resource] ?? []
}

function securityPayload(role: string, isOwner: boolean) {
  return {
    currentMember: { role, isOwner },
    roles: [
      { role: "super-admin", permission: denOrganizationStaticRoles["super-admin"].statements },
      { role: "admin", permission: denDefaultDynamicOrganizationRoles.admin },
      { role: "member", permission: denDefaultDynamicOrganizationRoles.member },
    ],
  }
}

describe("organization settings permissions", () => {
  test("admin can read settings resources but cannot mutate security configuration", () => {
    expect(canManageSecurityConfiguration(securityPayload("admin", false))).toBe(false)

    const adminPermission = resolveOrganizationPermissionRecord("admin", securityPayload("admin", false).roles)
    expect(actions(adminPermission, "invitation")).toEqual(["create", "cancel"])
    expect(actions(adminPermission, "team")).toEqual(["create", "update", "delete"])
    expect(actions(adminPermission, "organization")).toEqual([])
    expect(actions(adminPermission, "member")).toEqual(["delete"])
    expect(actions(adminPermission, "ac")).toEqual(["read"])
    expect(actions(adminPermission, "security_configuration")).toEqual([])
  })

  test("owner and super-admin can mutate settings resources", () => {
    expect(canManageSecurityConfiguration(securityPayload("owner", true))).toBe(true)
    expect(canManageSecurityConfiguration(securityPayload("super-admin", false))).toBe(true)
  })

  test("seeded super-admin is owner-equivalent and admin stale permissions are overwritten", () => {
    expect(denOrganizationStaticRoles["super-admin"].statements).toEqual(denOrganizationStaticRoles.owner.statements)
    expect(denDefaultDynamicOrganizationRoles["super-admin"]).toEqual(denOrganizationStaticRoles.owner.statements)

    const seededAdmin = denDefaultDynamicOrganizationRoles.admin
    expect(actions(seededAdmin, "organization")).toEqual([])
    expect(actions(seededAdmin, "member")).toEqual(["delete"])
    expect(actions(seededAdmin, "ac")).toEqual(["read"])
    expect(actions(seededAdmin, "security_configuration")).toEqual([])
  })
})
