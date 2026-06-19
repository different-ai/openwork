import { expect, test } from "bun:test"
import {
  getOrganizationSsoJitRole,
  ORGANIZATION_SSO_JIT_ROLE,
  SSO_IDENTITY_EXTRA_FIELDS,
} from "../src/sso-jit.js"

test("SSO JIT provisioning always assigns the baseline member role", async () => {
  const role = await getOrganizationSsoJitRole({
    userInfo: {
      role: "admin",
      groups: ["owners"],
    },
  })

  expect(role).toBe(ORGANIZATION_SSO_JIT_ROLE)
})

test("SSO identity mapping excludes authorization attributes", () => {
  expect(SSO_IDENTITY_EXTRA_FIELDS).toEqual({
    department: "department",
  })
  expect("role" in SSO_IDENTITY_EXTRA_FIELDS).toBe(false)
  expect("groups" in SSO_IDENTITY_EXTRA_FIELDS).toBe(false)
})
