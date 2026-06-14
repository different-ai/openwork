import { expect, test } from "bun:test"
import {
  cloneOrganizationPermissionCatalog,
  filterOrganizationPermissionRecord,
  resolveOrganizationPermissionRecord,
  SECURITY_CONFIGURATION_PERMISSION_ACTION,
  SECURITY_CONFIGURATION_PERMISSION_RESOURCE,
  validateAssignableOrganizationPermissionRecord,
  validateOrganizationPermissionRecord,
  type OrganizationPermissionRecord,
  type OrganizationRolePermission,
} from "../src/organization-access.js"

function role(roleName: string, permission: OrganizationPermissionRecord): OrganizationRolePermission {
  return {
    role: roleName,
    permission,
  }
}

test("organization role permissions reject unknown resources", () => {
  expect(validateOrganizationPermissionRecord({
    billing: ["delete"],
  })).toEqual({
    ok: false,
    error: "invalid_permission",
    message: 'Unsupported permission resource "billing".',
  })
})

test("organization role permissions reject unknown actions", () => {
  expect(validateOrganizationPermissionRecord({
    organization: ["create"],
  })).toEqual({
    ok: false,
    error: "invalid_permission",
    message: 'Unsupported permission action "organization.create".',
  })
})

test("organization role permissions allow catalog permissions", () => {
  expect(validateOrganizationPermissionRecord({
    ac: ["read"],
    invitation: ["create", "cancel"],
    [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
  })).toEqual({ ok: true })
})

test("organization role permissions cannot exceed the assigner permission set", () => {
  const limitedPermission = { ac: ["read"] }
  const roles = [
    role("limited", limitedPermission),
  ]

  expect(validateAssignableOrganizationPermissionRecord({
    permission: { ac: ["delete"] },
    roleValue: "limited",
    roles,
  })).toEqual({
    ok: false,
    error: "invalid_permission",
    message: 'Cannot assign permission "ac.delete".',
  })

  expect(validateAssignableOrganizationPermissionRecord({
    permission: { [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION] },
    roleValue: "limited",
    roles,
  })).toEqual({
    ok: false,
    error: "invalid_permission",
    message: `Cannot assign permission "${SECURITY_CONFIGURATION_PERMISSION_RESOURCE}.${SECURITY_CONFIGURATION_PERMISSION_ACTION}".`,
  })
})

test("organization owners can assign permissions from the fixed catalog", () => {
  const ownerPermission = cloneOrganizationPermissionCatalog()
  const roles = [
    role("owner", ownerPermission),
  ]

  expect(validateAssignableOrganizationPermissionRecord({
    permission: ownerPermission,
    roleValue: "owner",
    roles,
  })).toEqual({ ok: true })
})

test("default admins cannot assign delegated security configuration roles", () => {
  const roles = [
    role("admin", {
      organization: ["update"],
      invitation: ["create", "cancel"],
      member: ["create", "update", "delete"],
      team: ["create", "update", "delete"],
      ac: ["create", "read", "update", "delete"],
    }),
    role("security-admin", {
      [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
    }),
  ]

  expect(validateAssignableOrganizationPermissionRecord({
    permission: resolveOrganizationPermissionRecord("security-admin", roles),
    roleValue: "admin",
    roles,
  })).toEqual({
    ok: false,
    error: "invalid_permission",
    message: `Cannot assign permission "${SECURITY_CONFIGURATION_PERMISSION_RESOURCE}.${SECURITY_CONFIGURATION_PERMISSION_ACTION}".`,
  })
})

test("legacy stored permissions are filtered to the catalog when read", () => {
  expect(filterOrganizationPermissionRecord({
    ac: ["read", "delete", "unknown"],
    billing: ["delete"],
    [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
  })).toEqual({
    ac: ["read", "delete"],
    [SECURITY_CONFIGURATION_PERMISSION_RESOURCE]: [SECURITY_CONFIGURATION_PERMISSION_ACTION],
  })
})
