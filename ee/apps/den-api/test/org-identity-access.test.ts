import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let sharedModule: typeof import("../src/routes/org/shared.js")

beforeAll(async () => {
  seedRequiredEnv()
  sharedModule = await import("../src/routes/org/shared.js")
})

test("identity configuration management is owner-only", () => {
  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: true, role: "owner" },
  })).toBe(true)

  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: false, role: "admin" },
  })).toBe(false)

  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: false, role: "member" },
  })).toBe(false)

  expect(sharedModule.canManageIdentityConfiguration(null)).toBe(false)
})
