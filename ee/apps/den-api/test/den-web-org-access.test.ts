import { expect, test } from "bun:test"
import { canManageSecurityConfiguration } from "../src/organization-access.js"

test("settings mutation access is limited to owner and super-admin roles", () => {
  expect(canManageSecurityConfiguration({
    currentMember: { role: "admin", isOwner: false },
    roles: [],
  })).toBe(false)

  expect(canManageSecurityConfiguration({
    currentMember: { role: "security-admin", isOwner: false },
    roles: [{ role: "security-admin", permission: { security_configuration: ["manage"] } }],
  })).toBe(false)

  expect(canManageSecurityConfiguration({
    currentMember: { role: "super-admin", isOwner: false },
    roles: [],
  })).toBe(true)
})
