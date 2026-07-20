import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = ""
  process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = "false"
}

let authRoutesModule: typeof import("../src/routes/auth/index.js")
let meRoutesModule: typeof import("../src/routes/me/index.js")
let orgCoreModule: typeof import("../src/routes/org/core.js")

beforeAll(async () => {
  seedRequiredEnv()
  authRoutesModule = await import("../src/routes/auth/index.js")
  meRoutesModule = await import("../src/routes/me/index.js")
  orgCoreModule = await import("../src/routes/org/core.js")
})

function createSignedOrgCoreApp() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_single_org_route",
      name: "Single Org User",
      email: "user@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", null)
    c.set("apiKey", null)
    await next()
  })
  orgCoreModule.registerOrgCoreRoutes(app)
  return app
}

test("POST /v1/org is blocked in single_org mode before creating another organization", async () => {
  const app = createSignedOrgCoreApp()
  const response = await app.request("http://den.local/v1/org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Second Workspace" }),
  })

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    error: "single_org_mode",
    message: "This deployment is configured for one organization. New organizations cannot be created.",
  })
})

test("raw Better Auth organization creation is blocked in single_org mode", async () => {
  const app = new Hono()
  authRoutesModule.registerAuthRoutes(app)

  const response = await app.request("http://den.local/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Second Workspace", slug: "second-workspace" }),
  })

  expect(response.status).toBe(409)
  await expect(response.json()).resolves.toEqual({
    error: "single_org_mode",
    message: "This deployment is configured for one organization. Additional organization changes are disabled.",
  })
})

test("raw Better Auth email signup is blocked in private single_org mode before Better Auth validation", async () => {
  const app = new Hono()
  authRoutesModule.registerAuthRoutes(app)

  const response = await app.request("http://den.local/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "invited@example.com", name: "Invited User", password: "x" }),
  })

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({
    error: "single_org_signup_disabled",
    message: "Email signup is disabled for this deployment. Use your organization's SSO or a pre-provisioned account to sign in.",
  })
})

test("single_org active organization selection only allows the singleton candidate", () => {
  const singleton = { id: "organization_single", slug: "default" }
  const other = { id: "organization_other", slug: "other" }
  const orgs = [singleton, other]

  expect(meRoutesModule.getAllowedSingleOrgActiveOrganization({
    orgs,
    requestedOrgId: singleton.id,
  })).toEqual(singleton)

  expect(meRoutesModule.getAllowedSingleOrgActiveOrganization({
    orgs,
    requestedOrgId: other.id,
  })).toBeNull()

  expect(meRoutesModule.getAllowedSingleOrgActiveOrganization({
    orgs,
    requestedOrgId: null,
    requestedOrgSlug: singleton.slug,
  })).toEqual(singleton)

  expect(meRoutesModule.getAllowedSingleOrgActiveOrganization({
    orgs,
    requestedOrgId: null,
    requestedOrgSlug: other.slug,
  })).toBeNull()
})

test("raw Better Auth active organization switching only allows singleton no-op or singleton slug", () => {
  expect(authRoutesModule.canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId: "organization_single",
    singleOrganizationSlug: "default",
    requestedOrganizationId: "organization_single",
    requestedOrganizationSlug: "default",
  })).toBe(true)

  expect(authRoutesModule.canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId: "organization_single",
    singleOrganizationSlug: "default",
  })).toBe(true)

  expect(authRoutesModule.canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId: null,
    singleOrganizationSlug: "default",
    requestedOrganizationSlug: "default",
  })).toBe(true)

  expect(authRoutesModule.canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId: "organization_single",
    singleOrganizationSlug: "default",
    requestedOrganizationId: "organization_other",
  })).toBe(false)

  expect(authRoutesModule.canSetActiveOrganizationInSingleOrgMode({
    activeOrganizationId: "organization_single",
    singleOrganizationSlug: "default",
    requestedOrganizationSlug: "other",
  })).toBe(false)

  expect(authRoutesModule.isBetterAuthOrganizationCreationRequest(new Request("http://den.local/api/auth/organization/create", {
    method: "POST",
  }))).toBe(true)

  expect(authRoutesModule.isBetterAuthSetActiveOrganizationRequest(new Request("http://den.local/api/auth/organization/set-active", {
    method: "POST",
  }))).toBe(true)
})

test("single_org SSO-only guard recognizes email/password auth requests", () => {
  expect(authRoutesModule.isBetterAuthEmailPasswordRequest(new Request("http://den.local/api/auth/sign-in/email", {
    method: "POST",
  }))).toBe(true)

  expect(authRoutesModule.isBetterAuthEmailPasswordRequest(new Request("http://den.local/api/auth/sign-up/email", {
    method: "POST",
  }))).toBe(true)

  expect(authRoutesModule.isBetterAuthEmailPasswordRequest(new Request("http://den.local/api/auth/sign-in/social", {
    method: "POST",
  }))).toBe(false)

  expect(authRoutesModule.isBetterAuthEmailPasswordRequest(new Request("http://den.local/api/auth/sign-in/email", {
    method: "GET",
  }))).toBe(false)
})

test("single_org signup guard recognizes only the Better Auth email signup route", () => {
  expect(authRoutesModule.isBetterAuthEmailSignupRequest(new Request("http://den.local/api/auth/sign-up/email", {
    method: "POST",
  }))).toBe(true)

  expect(authRoutesModule.isBetterAuthEmailSignupRequest(new Request("http://den.local/api/auth/sign-in/email", {
    method: "POST",
  }))).toBe(false)

  expect(authRoutesModule.isBetterAuthEmailSignupRequest(new Request("http://den.local/api/auth/sign-up/email", {
    method: "GET",
  }))).toBe(false)
})

test("bearer-aware sign-out only recognizes the Better Auth POST route", () => {
  expect(authRoutesModule.isBetterAuthSignOutRequest(new Request("http://den.local/api/auth/sign-out", {
    method: "POST",
  }))).toBe(true)
  expect(authRoutesModule.isBetterAuthSignOutRequest(new Request("http://den.local/api/auth/sign-out", {
    method: "GET",
  }))).toBe(false)
  expect(authRoutesModule.isBetterAuthSignOutRequest(new Request("http://den.local/api/auth/revoke-session", {
    method: "POST",
  }))).toBe(false)
})
