import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let invitationModule: typeof import("../src/routes/org/invitations.js")
let orgRoutesModule: typeof import("../src/routes/org/index.js")
let orgsModule: typeof import("../src/orgs.js")
let authModule: typeof import("../src/auth.js")
let userOrganizationsModule: typeof import("../src/middleware/user-organizations.js")

beforeAll(async () => {
  seedRequiredEnv()
  invitationModule = await import("../src/routes/org/invitations.js")
  orgRoutesModule = await import("../src/routes/org/index.js")
  orgsModule = await import("../src/orgs.js")
  authModule = await import("../src/auth.js")
  userOrganizationsModule = await import("../src/middleware/user-organizations.js")
})

function createOrgApp() {
  const app = new Hono()
  orgRoutesModule.registerOrgRoutes(app)
  return app
}

test("legacy org-scoped paths proxy into the unscoped handlers", async () => {
  const app = createOrgApp()
  const response = await app.request("http://den.local/v1/orgs/org_123/invitations", {
    body: JSON.stringify({ email: "teammate@example.com", role: "admin" }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})

test("legacy org-scoped proxy also reaches non-invitation org resources", async () => {
  const app = createOrgApp()
  const response = await app.request("http://den.local/v1/orgs/org_123/teams", {
    body: JSON.stringify({ memberIds: [], name: "Legacy Team" }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})

test("current org endpoints are not swallowed by the legacy proxy", async () => {
  const app = createOrgApp()
  const response = await app.request("http://den.local/v1/orgs/invitations/preview?id=", {
    method: "GET",
  })

  expect(response.status).toBe(400)
})

test("invitation cancel still validates against the unscoped handler", async () => {
  const app = new Hono()
  invitationModule.registerOrgInvitationRoutes(app)
  const response = await app.request("http://den.local/v1/invitations/invitation_123/cancel", {
    method: "POST",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})

test("invitation lookup accepts both invitation IDs and invite tokens", () => {
  const invitationId = "inv_01j00000000000000000000000"
  expect(orgsModule.parseInvitationLookupIdentifier(invitationId)).toEqual({
    invitationId,
    inviteToken: invitationId,
  })
  expect(orgsModule.parseInvitationLookupIdentifier(" invite-token-123 ")).toEqual({
    invitationId: null,
    inviteToken: "invite-token-123",
  })
})

test("dev sign-up rate limit remains higher than production", () => {
  expect(authModule.getSignUpEmailRateLimitMax(true)).toBe(100)
  expect(authModule.getSignUpEmailRateLimitMax(false)).toBe(3)
})

test("session hydration only runs when a user session is missing an active organization", () => {
  expect(userOrganizationsModule.shouldHydrateSessionActiveOrganization({
    scopedOrganizationId: null,
    sessionActiveOrganizationId: null,
    resolvedActiveOrganizationId: "organization_first",
  })).toBe(true)

  expect(userOrganizationsModule.shouldHydrateSessionActiveOrganization({
    scopedOrganizationId: null,
    sessionActiveOrganizationId: "organization_existing",
    resolvedActiveOrganizationId: "organization_existing",
  })).toBe(false)

  expect(userOrganizationsModule.shouldHydrateSessionActiveOrganization({
    scopedOrganizationId: "organization_scoped",
    sessionActiveOrganizationId: null,
    resolvedActiveOrganizationId: "organization_scoped",
  })).toBe(false)
})
