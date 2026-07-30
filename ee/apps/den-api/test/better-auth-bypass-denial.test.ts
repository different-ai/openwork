import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let getRawBetterAuthMutationDenial: typeof import("../src/auth.js")["getRawBetterAuthMutationDenial"]

beforeAll(async () => {
  seedRequiredEnv()
  getRawBetterAuthMutationDenial = (await import("../src/auth.js")).getRawBetterAuthMutationDenial
})

test("raw Better Auth organization governance and settings mutations are denied", () => {
  expect(getRawBetterAuthMutationDenial("/organization/update")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/delete")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/update-member-role")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/remove-member")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/create-role")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/update-role")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/organization/delete-role")?.error).toBe("forbidden")
})

test("raw Better Auth SSO, SCIM, and API-key mutations are denied", () => {
  expect(getRawBetterAuthMutationDenial("/sso/register")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/sso/update-provider")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/sso/delete-provider")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/sso/request-domain-verification")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/sso/verify-domain")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/scim/generate-token")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/scim/delete-provider-connection")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/api-key/create")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/api-key/update")?.error).toBe("forbidden")
  expect(getRawBetterAuthMutationDenial("/api-key/delete")?.error).toBe("forbidden")
})

test("supported raw operational and read routes are not denied by the bypass guard", () => {
  expect(getRawBetterAuthMutationDenial("/organization/invite-member")).toBeNull()
  expect(getRawBetterAuthMutationDenial("/organization/add-member")).toBeNull()
  expect(getRawBetterAuthMutationDenial("/organization/create-team")).toBeNull()
  expect(getRawBetterAuthMutationDenial("/sso/providers")).toBeNull()
  expect(getRawBetterAuthMutationDenial("/api-key/list")).toBeNull()
})
