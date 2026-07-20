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

test("identity configuration management requires owner or delegated security permission", () => {
  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: true, role: "owner" },
    roles: [],
  })).toBe(true)

  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: false, role: "admin" },
    roles: [],
  })).toBe(false)

  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: false, role: "member" },
    roles: [],
  })).toBe(false)

  expect(sharedModule.canManageIdentityConfiguration({
    currentMember: { isOwner: false, role: "security-admin" },
    roles: [
      { role: "security-admin", permission: { security_configuration: ["manage"] } },
    ],
  })).toBe(true)

  expect(sharedModule.canManageIdentityConfiguration(null)).toBe(false)
})

test("api key management requires owner or delegated security permission", () => {
  expect(sharedModule.canManageApiKeys({
    currentMember: { isOwner: true, role: "owner" },
    roles: [],
  })).toBe(true)

  expect(sharedModule.canManageApiKeys({
    currentMember: { isOwner: false, role: "admin" },
    roles: [],
  })).toBe(false)

  expect(sharedModule.canManageApiKeys({
    currentMember: { isOwner: false, role: "member" },
    roles: [],
  })).toBe(false)

  expect(sharedModule.canManageApiKeys({
    currentMember: { isOwner: false, role: "security-admin" },
    roles: [
      { role: "security-admin", permission: { security_configuration: ["manage"] } },
    ],
  })).toBe(true)

  expect(sharedModule.canManageApiKeys(null)).toBe(false)
})

test("privileged actions require a fresh session", () => {
  const now = new Date("2026-06-13T12:00:00.000Z")

  expect(sharedModule.hasFreshPrivilegedSession({
    session: { createdAt: new Date(now.getTime() - sharedModule.PRIVILEGED_SESSION_MAX_AGE_MS) },
  }, now)).toBe(true)

  expect(sharedModule.hasFreshPrivilegedSession({
    session: { createdAt: new Date(now.getTime() - sharedModule.PRIVILEGED_SESSION_MAX_AGE_MS - 1) },
  }, now)).toBe(false)

  expect(sharedModule.hasFreshPrivilegedSession({
    session: { createdAt: new Date(now.getTime() + 1) },
  }, now)).toBe(false)

  expect(sharedModule.hasFreshPrivilegedSession({ session: null }, now)).toBe(false)
})

test("read-only connection settings accept a login from the last 24 hours", () => {
  const now = new Date("2026-06-13T12:00:00.000Z")
  const session = {
    createdAt: new Date(now.getTime() - sharedModule.CONNECTIONS_READ_SESSION_MAX_AGE_MS),
  }

  expect(sharedModule.hasFreshPrivilegedSession({ session }, now)).toBe(false)
  expect(sharedModule.hasFreshPrivilegedSession(
    { session },
    now,
    sharedModule.CONNECTIONS_READ_SESSION_MAX_AGE_MS,
  )).toBe(true)

  expect(sharedModule.hasFreshPrivilegedSession({
    session: { createdAt: new Date(now.getTime() - sharedModule.CONNECTIONS_READ_SESSION_MAX_AGE_MS - 1) },
  }, now, sharedModule.CONNECTIONS_READ_SESSION_MAX_AGE_MS)).toBe(false)
})

test("routine admin authorization checks the role without requiring session freshness", () => {
  const message = "Only workspace owners and admins can configure this integration."

  expect(sharedModule.ensureOrganizationAdminRole({
    get: () => ({
      currentMember: { isOwner: false, role: "member,admin" },
    }),
  }, message)).toEqual({ ok: true })

  expect(sharedModule.ensureOrganizationAdminRole({
    get: () => ({
      currentMember: { isOwner: false, role: "member" },
    }),
  }, message)).toEqual({
    ok: false,
    response: {
      error: "forbidden",
      message,
    },
  })
})

test("reauth failures remain forbidden responses", () => {
  expect(sharedModule.orgAccessFailureStatus({ error: "reauth" })).toBe(403)
  expect(sharedModule.orgAccessFailureStatus({ error: "forbidden" })).toBe(403)
  expect(sharedModule.orgAccessFailureStatus({ error: "organization_not_found" })).toBe(404)
})

test("freshness failures share the standardized reauth response", () => {
  expect(sharedModule.getFreshPrivilegedSessionRequiredResponse()).toEqual({
    error: "reauth",
    reason: "fresh_auth_required",
    message: sharedModule.WORKSPACE_REAUTH_SECURITY_MESSAGE,
  })
})
