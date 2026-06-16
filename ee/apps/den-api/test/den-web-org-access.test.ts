import { expect, test } from "bun:test"
import { DEN_ROLE_PERMISSION_OPTIONS, getOrgAccessFlags, type DenOrgRole } from "../../den-web/app/(den)/_lib/den-org.ts"

function role(roleName: string, permission: Record<string, string[]>): DenOrgRole {
  return {
    id: `role_${roleName}`,
    role: roleName,
    permission,
    builtIn: roleName === "admin" || roleName === "member",
    protected: roleName === "admin" || roleName === "member",
    createdAt: null,
    updatedAt: null,
  }
}

test("default admin access does not include security configuration", () => {
  const access = getOrgAccessFlags("admin", false, [
    role("admin", { member: ["create", "update", "delete"] }),
  ])

  expect(access.isAdmin).toBe(true)
  expect(access.canInviteMembers).toBe(true)
  expect(access.canManageApiKeys).toBe(false)
  expect(access.canManageScim).toBe(false)
  expect(access.canManageSso).toBe(false)
})

test("delegated security configuration role can manage identity settings", () => {
  const access = getOrgAccessFlags("security-admin", false, [
    role("security-admin", { security_configuration: ["manage"] }),
  ])

  expect(access.isAdmin).toBe(false)
  expect(access.canInviteMembers).toBe(false)
  expect(access.canManageSecurityConfiguration).toBe(true)
  expect(access.canManageApiKeys).toBe(true)
  expect(access.canManageScim).toBe(true)
  expect(access.canManageSso).toBe(true)
})

test("role editor exposes security configuration delegation", () => {
  expect(DEN_ROLE_PERMISSION_OPTIONS.security_configuration).toEqual(["manage"])
})
