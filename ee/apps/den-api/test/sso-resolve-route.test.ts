import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
  process.env.OPENWORK_DEV_MODE = "0"
}

type EnterpriseRequirement = {
  organizationId: string
  organizationSlug: string
  signInPath: string
  ssoProviderId: string | null
  hasSso: boolean
}

let botAllowed = true
let retryAfter: number | null = null
let requirement: EnterpriseRequirement | null = null
let nonSsoMethod: "google" | "password" | "signup" = "signup"
let registerOrgCoreRoutes: typeof import("../src/routes/org/core.js").registerOrgCoreRoutes
let registerAuthRoutes: typeof import("../src/routes/auth/index.js").registerAuthRoutes

mock.module("../src/bot-protection.js", () => ({
  verifyBotProtection: async () => botAllowed
    ? { ok: true }
    : { ok: false, status: 403, message: "Request verification failed." },
}))

mock.module("../src/utils/rate-limit.js", () => ({
  checkRateLimit: async () => retryAfter,
  enforceRateLimit: async () => retryAfter,
}))

mock.module("../src/enterprise-auth-requirement.js", () => ({
  findEnterpriseAuthRequirementForEmail: async () => null,
  findEnterpriseAuthRequirementForEmailDomain: async () => requirement,
  findEnterpriseAuthRequirementForUserId: async () => null,
  resolveNonSsoSignInMethodForEmail: async () => nonSsoMethod,
}))

beforeAll(async () => {
  seedRequiredEnv()
  const [orgModule, authModule] = await Promise.all([
    import("../src/routes/org/core.js"),
    import("../src/routes/auth/index.js"),
  ])
  registerOrgCoreRoutes = orgModule.registerOrgCoreRoutes
  registerAuthRoutes = authModule.registerAuthRoutes
})

beforeEach(() => {
  botAllowed = true
  retryAfter = null
  requirement = null
  nonSsoMethod = "signup"
})

function createApp() {
  const app = new Hono()
  registerOrgCoreRoutes(app)
  return app
}

function createAuthApp() {
  const app = new Hono()
  registerAuthRoutes(app)
  return app
}

test("SSO resolve returns a uniform 200 domain-routed SSO envelope", async () => {
  requirement = {
    organizationId: "organization_sso_resolve_test",
    organizationSlug: "verified-sso",
    signInPath: "/sso/verified-sso",
    ssoProviderId: "openwork-sso-organization_sso_resolve_test",
    hasSso: true,
  }

  const response = await createApp().request("http://den.local/v1/orgs/sso/resolve?email=fake@verified.example.test")
  const body = await response.json()

  expect(response.status).toBe(200)
  expect(body).toEqual({
    requireSso: true,
    method: "sso",
    organizationSlug: "verified-sso",
    signInPath: "/sso/verified-sso",
    signInUrl: "http://127.0.0.1:8790/sso/verified-sso",
  })
})

test("SSO resolve no longer returns 204 for unknown emails", async () => {
  nonSsoMethod = "signup"

  const response = await createApp().request("http://den.local/v1/orgs/sso/resolve?email=unknown@example.test")
  const body = await response.json()

  expect(response.status).toBe(200)
  expect(body).toEqual({ requireSso: false, method: "signup" })
})

test("SSO resolve preserves non-SSO method routing without sensitive fields", async () => {
  nonSsoMethod = "google"

  const response = await createApp().request("http://den.local/v1/orgs/sso/resolve?email=google@example.test")
  const body = await response.json()

  expect(response.status).toBe(200)
  expect(body).toEqual({ requireSso: false, method: "google" })
  expect(JSON.stringify(body)).not.toContain("user")
  expect(JSON.stringify(body)).not.toContain("organization")
})

test("SSO resolve requires BotID verification before route-specific disclosure", async () => {
  botAllowed = false

  const response = await createApp().request("http://den.local/v1/orgs/sso/resolve?email=google@example.test")
  const body = await response.json()

  expect(response.status).toBe(403)
  expect(body).toEqual({
    error: "bot_verification_failed",
    message: "Request verification failed.",
  })
})

test("SSO resolve returns 429 when route-specific rate limiting blocks the lookup", async () => {
  retryAfter = 30

  const response = await createApp().request("http://den.local/v1/orgs/sso/resolve?email=google@example.test")
  const body = await response.json()

  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("30")
  expect(body).toEqual({
    error: "rate_limited",
    message: "Too many sign-in resolution attempts. Try again later.",
  })
})

test("login-options also requires BotID before deterministic auth-method routing", async () => {
  botAllowed = false

  const response = await createAuthApp().request("http://den.local/v1/auth/login-options?email=google@example.test")
  const body = await response.json()

  expect(response.status).toBe(403)
  expect(body).toEqual({
    error: "bot_verification_failed",
    message: "Request verification failed.",
  })
  expect(response.headers.getSetCookie()).toContain("__Secure-better-auth.session_token=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax")
})

test("login-options returns SSO as the first step for verified SSO domains", async () => {
  requirement = {
    organizationId: "organization_sso_invite_test",
    organizationSlug: "invite-sso",
    signInPath: "/sso/invite-sso",
    ssoProviderId: "openwork-sso-organization_sso_invite_test",
    hasSso: true,
  }

  const response = await createAuthApp().request("http://den.local/v1/auth/login-options?email=invited@verified.example.test")
  const body = await response.json()

  expect(response.status).toBe(200)
  expect(body).toEqual({
    email: "invited@verified.example.test",
    nextStep: "sso",
    allowPublicSignup: true,
    allowInvitationSignup: false,
    organizationSlug: "invite-sso",
    signInPath: "/sso/invite-sso",
    signInUrl: "http://127.0.0.1:8790/sso/invite-sso",
  })
})
