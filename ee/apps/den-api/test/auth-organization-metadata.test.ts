import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { createAuthMiddleware } from "better-auth/api"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import { createDenDb, InvitationTable } from "@openwork-ee/den-db"

// Auth initializes OAuth resource seeds even when only its organization hooks are
// used. Represent already-seeded resources without opening an ambient database.
let invitation = { id: "public-invitation-id", inviteToken: "raw-invitation-token", email: "member@example.test", status: "pending", expiresAt: new Date(Date.now() + 60_000) }
let requireSso = false
const sentEmails: unknown[] = []
const queryDb = createDenDb({ mode: "planetscale", planetscale: { host: "unused.example.test", username: "fixture", password: "fixture" } }).db
const rows = {
  from: () => rows,
  where: (condition: SQL) => {
    const query = queryDb.select().from(InvitationTable).where(condition).toSQL()
    return Object.assign(Promise.resolve([{ id: "fixture-resource" }]), {
      limit: async () => {
        expect(query.sql).toContain("`invite_token` = ?")
        expect(query.sql).not.toContain(" or ")
        expect(query.sql).toContain("`status` = ?")
        expect(query.sql).toContain("`expires_at` > ?")
        expect(query.sql).toContain("lower(")
        const [token, status, expiresAt, email] = query.params
        return token === invitation.inviteToken && status === invitation.status
          && typeof expiresAt === "string" && invitation.expiresAt > new Date(expiresAt)
          && email === invitation.email ? [invitation] : []
      },
    })
  },
}
mock.module("../src/db.js", () => ({ db: { select: () => rows } }))
mock.module("../src/utils/email/send-email.js", () => ({ sendEmail: async (input: unknown) => { sentEmails.push(input) } }))
mock.module("../src/enterprise-auth-requirement.js", () => ({
  findEnterpriseAuthRequirementForEmail: async () => requireSso ? { signInPath: "/sso/test" } : null,
  findEnterpriseAuthRequirementForUserId: async () => null,
}))

let auth: typeof import("../src/auth.js")["auth"]

beforeAll(async () => {
  process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected"
  process.env.DB_MODE = "mysql"
  process.env.GATEWAY_ENABLED = "false"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
  process.env.DEN_REQUIRE_EMAIL_VERIFICATION = "true"
  auth = (await import("../src/auth.js")).auth
  await auth.$context
})

afterAll(() => mock.restore())

async function beforeCreate(metadata: unknown) {
  // Invoke the registered hook, not the DB-backed organization creation endpoint.
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id === "organization") {
      return plugin.options.organizationHooks.beforeCreateOrganization({
        // Better Auth types only objects; the runtime boundary also needs malformed/string coverage.
        organization: { name: "Test Workspace", slug: "test-workspace", metadata: metadata as Record<string, unknown> },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
      })
    }
  }
  throw new Error("Organization hook not registered")
}

test.each([true, false, null, "true", 1])("public creation cannot set platform-managed gatewayDashboard to %s", async (value) => {
  const metadata = { capabilities: { gatewayDashboard: value } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    await expect(beforeCreate(input)).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { message: "capabilities.gatewayDashboard is reserved for internal platform administration." },
    })
  }
})

test("ordinary metadata and other capability overrides retain their existing behavior", async () => {
  for (const metadata of [undefined, null, {}, { label: "test" }, { capabilities: {} }, { capabilities: { inference: false, desktop: true } }]) {
    await expect(beforeCreate(metadata)).resolves.toBeUndefined()
    if (metadata !== undefined) await expect(beforeCreate(JSON.stringify(metadata === null ? {} : metadata))).resolves.toBeUndefined()
  }
})

test("existing malformed metadata and dpaSigned denials are preserved", async () => {
  for (const metadata of ["not-json", "[]", "true", 42, []]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({ status: "BAD_REQUEST" })
  }
  for (const metadata of [{ dpaSigned: true }, JSON.stringify({ dpaSigned: false })]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "dpaSigned is reserved for internal platform administration." },
    })
  }
})

test("public organization updates cannot replace capability metadata", async () => {
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id !== "organization") continue
    for (const metadata of [{}, { capabilities: { gatewayDashboard: true } }, { capabilities: { gatewayDashboard: false } }]) {
      await expect(plugin.options.organizationHooks.beforeUpdateOrganization({
        organization: { metadata },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
        member: { id: "test-member", organizationId: "test-org", userId: "test-user", role: "owner", createdAt: new Date(0) },
      })).rejects.toMatchObject({ status: "FORBIDDEN" })
    }
    return
  }
  throw new Error("Organization hook not registered")
})

test.each([
  { name: "valid raw token", token: "raw-invitation-token", email: " Member@Example.Test ", status: "pending", expired: false, verified: true },
  { name: "public invitation id", token: "public-invitation-id", email: "member@example.test", status: "pending", expired: false, verified: false },
  { name: "wrong email", token: "raw-invitation-token", email: "other@example.test", status: "pending", expired: false, verified: false },
  { name: "expired", token: "raw-invitation-token", email: "member@example.test", status: "pending", expired: true, verified: false },
  { name: "canceled", token: "raw-invitation-token", email: "member@example.test", status: "canceled", expired: false, verified: false },
  { name: "ordinary signup", token: "", email: "member@example.test", status: "pending", expired: false, verified: false },
])("password signup email proof: $name", async ({ token, email, status, expired, verified }) => {
  invitation = { ...invitation, status, expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)) }
  const invoke = createAuthMiddleware(async (context) => auth.options.databaseHooks.user.create.before({
    id: "test-user", name: "Member", email, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  }, context))
  const result = await invoke({
    path: "/sign-up/email",
    request: new Request(`http://127.0.0.1:8790/api/auth/sign-up/email${token ? `?invite=${token}` : ""}`),
    context: await auth.$context,
  })
  expect(result.data.emailVerified).toBe(verified)
  expect(result.data.email).toBe(email.trim().toLowerCase())
})

test("SSO requirement still rejects password signup with valid invitation proof", async () => {
  invitation = { ...invitation, status: "pending", expiresAt: new Date(Date.now() + 60_000) }
  requireSso = true
  try {
    await expect(auth.options.hooks.before({
      path: "/sign-up/email",
      body: { email: invitation.email },
      request: new Request("http://127.0.0.1:8790/api/auth/sign-up/email?invite=raw-invitation-token"),
      context: await auth.$context,
    })).rejects.toMatchObject({ status: "FORBIDDEN", body: { message: "This account is managed by an organization. Use SSO to sign in." } })
    await expect(auth.options.emailVerification.beforeEmailVerification({
      id: "test-user", name: "Member", email: invitation.email, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toMatchObject({ status: "FORBIDDEN" })
  } finally {
    requireSso = false
  }
  expect(auth.options.emailAndPassword.requireEmailVerification).toBe(true)
  expect(auth.options.emailVerification.autoSignInAfterVerification).toBe(true)
})

test("body-only invite claims do not prove email and non-password user creation preserves verification", async () => {
  for (const path of ["/sign-up/email", "/callback/:id", "/sso/callback/:providerId", "/scim/v2/Users"]) {
    for (const emailVerified of [false, true]) {
      const invoke = createAuthMiddleware(async (context) => auth.options.databaseHooks.user.create.before({
        id: "test-user", name: "Member", email: invitation.email, emailVerified, createdAt: new Date(), updatedAt: new Date(),
      }, context))
      const result = await invoke({
        path,
        body: { invite: "raw-invitation-token", emailVerified: true },
        request: new Request(`http://127.0.0.1:8790/api/auth${path}`),
        context: await auth.$context,
      })
      expect(result.data.emailVerified).toBe(path === "/sign-up/email" ? false : emailVerified)
    }
  }
})

test("verified invite signups skip verification email while ordinary signup gets canonical recovery URL", async () => {
  const authContext = await auth.$context
  const { env } = await import("../src/env.js")
  const findUser = spyOn(authContext.internalAdapter, "findUserByEmail")
  try {
    for (const emailVerified of [true, false]) {
      sentEmails.length = 0
      findUser.mockResolvedValue({ user: {
        id: "test-user", name: "Member", email: invitation.email, emailVerified, createdAt: new Date(), updatedAt: new Date(),
      }, accounts: [] })
      const invoke = createAuthMiddleware(async (context) => {
        for (const plugin of auth.options.plugins) {
          if (plugin.id === "email-otp") {
            await plugin.options.sendVerificationOTP({ email: invitation.email, otp: "123456", type: "email-verification" }, context)
            return
          }
        }
        throw new Error("Email OTP plugin missing")
      })
      await invoke({
        path: "/sign-up/email",
        request: new Request("https://untrusted.example.test/api/auth/sign-up/email", { headers: { origin: "https://untrusted.example.test" } }),
        context: authContext,
      })
      expect(sentEmails).toEqual(emailVerified ? [] : [{
        to: invitation.email,
        template: "verification",
        props: { verificationCode: "123456", recoveryUrl: new URL(`/verify?email=${encodeURIComponent(invitation.email)}`, env.webUrl).toString() },
      }])
    }
  } finally {
    findUser.mockRestore()
  }
})
