import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"
import { validateInvitationAcceptVerification } from "../src/organization-join-verification.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let orgRoutesModule: typeof import("../src/routes/org/index.js")

beforeAll(async () => {
  seedRequiredEnv()
  orgRoutesModule = await import("../src/routes/org/index.js")
})

// Builds an org app with a fake authenticated session so we can exercise the
// route guard without the session middleware or a live database. The handler
// rejects unverified users before any database access, so no MySQL is required.
function createOrgAppWithUser(user: { id: string; email: string; emailVerified: boolean }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", user)
    c.set("session", {
      id: "session_test",
      token: "session_test",
      userId: user.id,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    })
    c.set("apiKey", null)
    await next()
  })
  orgRoutesModule.registerOrgRoutes(app)
  return app
}

test("unverified accounts may create their own org and invite, but not join one", () => {
  // Unverified is the only blocked transition: joining someone else's org.
  expect(validateInvitationAcceptVerification({ emailVerified: false })).toEqual({
    ok: false,
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  })
  expect(validateInvitationAcceptVerification({ emailVerified: null })).toEqual({
    ok: false,
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  })
  expect(validateInvitationAcceptVerification({ emailVerified: undefined })).toEqual({
    ok: false,
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  })
})

test("verified accounts are allowed to join an organization", () => {
  expect(validateInvitationAcceptVerification({ emailVerified: true })).toEqual({ ok: true })
})

test("accept-invitation route blocks an unverified user with 403 before touching the database", async () => {
  const app = createOrgAppWithUser({
    id: "user_unverified",
    email: "agent@example.com",
    emailVerified: false,
  })

  const response = await app.request("http://den.local/v1/orgs/invitations/accept", {
    body: JSON.stringify({ id: "invitation_123" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  })
})

test("accept-invitation route still requires authentication", async () => {
  const app = new Hono()
  orgRoutesModule.registerOrgRoutes(app)
  const response = await app.request("http://den.local/v1/orgs/invitations/accept", {
    body: JSON.stringify({ id: "invitation_123" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})
