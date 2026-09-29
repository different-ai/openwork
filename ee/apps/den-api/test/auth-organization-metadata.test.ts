import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
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
        expect(query.sql).toContain(" or ")
        expect(query.sql).toContain("`status` = ?")
        expect(query.sql).toContain("`expires_at` > ?")
        expect(query.sql).toContain("lower(")
        const [id, token, status, expiresAt, email] = query.params
        return (id === invitation.id || token === invitation.inviteToken) && status === invitation.status
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
  process.env.DEN_ORG_MODE = "single_org"
  process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = "false"
  process.env.DEN_REQUIRE_EMAIL_VERIFICATION = "true"
  auth = (await import("../src/auth.js")).auth
  await auth.$context
})

afterAll(() => mock.restore())

function invokeAuthMiddleware<Result>(
  middleware: (input: { request?: Request }) => Promise<Result>,
  input: { path: string; request?: Request; body?: unknown; params?: Record<string, string>; context: Awaited<typeof auth.$context> & { returned?: unknown; responseHeaders?: Headers } },
) {
  // The SDK middleware input type omits the route metadata that its dispatcher
  // supplies at runtime. Forward it through the registered middleware boundary.
  return middleware(input)
}

const ssoCallbackPaths = ["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"]

function callbackSession() {
  const userId = createDenTypeId("user")
  return {
    user: { id: userId, name: "SSO Member", email: "member@example.test", emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
    session: { id: createDenTypeId("session"), userId, token: "sso-callback-test-token", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() },
  }
}

test.each(ssoCallbackPaths)("SSO session creation waits for JIT instead of reconciling or bootstrapping: %s", async (path) => {
  const orgs = await import("../src/orgs.js")
  const activeOrganization = await import("../src/active-organization.js")
  const reconcile = spyOn(orgs, "reconcilePendingInvitationsForUser").mockResolvedValue(0)
  const initialOrganization = spyOn(activeOrganization, "getInitialActiveOrganizationIdForUser").mockResolvedValue(null)
  try {
    const { session } = callbackSession()
    const invoke = createAuthMiddleware(async (context) => auth.options.databaseHooks.session.create.before(session, context))
    await invokeAuthMiddleware(invoke, { path, params: { providerId: "test-provider" }, context: await auth.$context })
    expect(reconcile).not.toHaveBeenCalled()
    expect(initialOrganization).not.toHaveBeenCalled()
  } finally {
    reconcile.mockRestore()
    initialOrganization.mockRestore()
  }
})

test.each(["/sign-in/email", "/sign-up/email", "/callback/:id"])("ordinary authentication defers membership until the account transaction commits: %s", async (path) => {
  const orgs = await import("../src/orgs.js")
  const activeOrganization = await import("../src/active-organization.js")
  const organizationId = createDenTypeId("organization")
  const reconcile = spyOn(orgs, "reconcilePendingInvitationsForUser").mockResolvedValue(1)
  const initialOrganization = spyOn(activeOrganization, "getInitialActiveOrganizationIdForUser").mockResolvedValue(organizationId)
  const context = await auth.$context
  const updateSession = spyOn(context.internalAdapter, "updateSession").mockResolvedValue(null)
  try {
    const newSession = callbackSession()
    const { session } = newSession
    const invoke = createAuthMiddleware(async (context) => auth.options.databaseHooks.session.create.before(session, context))
    const result = await invokeAuthMiddleware(invoke, { path, context })
    expect(result.data.activeOrganizationId).toBeNull()
    expect(reconcile).not.toHaveBeenCalled()
    expect(initialOrganization).not.toHaveBeenCalled()
    await invokeAuthMiddleware(auth.options.hooks.after, { path, context: { ...context, newSession } })
    expect(reconcile).toHaveBeenCalledWith(session.userId)
    expect(initialOrganization).toHaveBeenCalledWith(session.userId)
    expect(updateSession).toHaveBeenCalledWith(session.token, { activeOrganizationId: organizationId })
  } finally {
    updateSession.mockRestore()
    reconcile.mockRestore()
    initialOrganization.mockRestore()
  }
})

test.each(ssoCallbackPaths)("successful SSO callback reconciles only its authenticated user and provider after JIT: %s", async (path) => {
  const orgs = await import("../src/orgs.js")
  const reconcile = spyOn(orgs, "reconcileSsoInvitationsForUser").mockResolvedValue(1)
  const broadReconcile = spyOn(orgs, "reconcilePendingInvitationsForUser").mockResolvedValue(0)
  try {
    const newSession = callbackSession()
    // The SDK can retain a stale false flag here after independently verifying
    // the user. The org helper, not this hook snapshot, checks current DB proof.
    await invokeAuthMiddleware(auth.options.hooks.after, {
      path, params: { providerId: "test-provider" },
      context: { ...await auth.$context, newSession, returned: new APIError("FOUND"), responseHeaders: new Headers({ location: "http://127.0.0.1:8790/" }) },
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith({ userId: newSession.user.id, providerId: "test-provider" })
    expect(broadReconcile).not.toHaveBeenCalled()
  } finally {
    reconcile.mockRestore()
    broadReconcile.mockRestore()
  }
})

test.each(ssoCallbackPaths)("failed or incomplete SSO callbacks never reconcile: %s", async (path) => {
  const orgs = await import("../src/orgs.js")
  const reconcile = spyOn(orgs, "reconcileSsoInvitationsForUser").mockResolvedValue(0)
  try {
    const context = await auth.$context
    await invokeAuthMiddleware(auth.options.hooks.after, {
      path, params: { providerId: "test-provider" },
      context: { ...context, newSession: null, responseHeaders: new Headers({ location: "http://127.0.0.1:8790/?error=access_denied" }) },
    })
    await invokeAuthMiddleware(auth.options.hooks.after, {
      path, params: { providerId: "test-provider" },
      context: { ...context, newSession: callbackSession(), returned: new APIError("FORBIDDEN"), responseHeaders: new Headers({ location: "http://127.0.0.1:8790/" }) },
    })
    await invokeAuthMiddleware(auth.options.hooks.after, {
      path, params: { providerId: "test-provider" },
      context: { ...context, newSession: callbackSession(), returned: new APIError("FOUND"), responseHeaders: new Headers({ location: "http://127.0.0.1:8790/?error=access_denied" }) },
    })
    await invokeAuthMiddleware(auth.options.hooks.after, { path, params: { providerId: "test-provider" }, context: { ...context, newSession: callbackSession(), responseHeaders: new Headers() } })
    await invokeAuthMiddleware(auth.options.hooks.after, { path, context: { ...context, newSession: callbackSession() } })
    expect(reconcile).not.toHaveBeenCalled()
  } finally {
    reconcile.mockRestore()
  }
})

test.each(ssoCallbackPaths)("SSO configuration tests retain identity completion and remove the temporary session without accepting invites: %s", async (path) => {
  const orgs = await import("../src/orgs.js")
  const lifecycle = await import("../src/sso-test-lifecycle.js")
  const { cache } = await import("../src/cache.js")
  const context = await auth.$context
  const reconcile = spyOn(orgs, "reconcileSsoInvitationsForUser").mockResolvedValue(0)
  // A mismatched identity still gets passed to the original completion check,
  // and its temporary session must be removed even though the test is rejected.
  const complete = spyOn(lifecycle, "completeOrganizationSsoTestIntent").mockResolvedValue({ ok: false })
  const fail = spyOn(lifecycle, "failOrganizationSsoTestIntent").mockResolvedValue(true)
  const deleteSession = spyOn(context.internalAdapter, "deleteSession").mockResolvedValue(undefined)
  const revokeSession = spyOn(cache.auth, "revokeSession").mockResolvedValue(undefined)
  try {
    const newSession = callbackSession()
    const responseHeaders = new Headers({ location: "http://127.0.0.1:8790/sso/test/complete?openworkSsoTest=test-intent" })
    responseHeaders.append("set-cookie", `${context.authCookies.sessionToken.name}=temporary; Path=/`)
    responseHeaders.append("set-cookie", "unrelated=retained; Path=/")
    await invokeAuthMiddleware(auth.options.hooks.after, { path, params: { providerId: "test-provider" }, context: { ...context, newSession, responseHeaders } })
    expect(complete).toHaveBeenCalledWith({ intentId: "test-intent", providerId: "test-provider", authenticatedUserId: newSession.user.id })
    expect(deleteSession).toHaveBeenCalledWith(newSession.session.token)
    expect(revokeSession).toHaveBeenCalledWith(newSession.session.token)
    expect(responseHeaders.getSetCookie()).toEqual(["unrelated=retained; Path=/"])
    await invokeAuthMiddleware(auth.options.hooks.after, { path, params: { providerId: "test-provider" }, context: { ...context, newSession: null, responseHeaders } })
    expect(fail).toHaveBeenCalledWith("test-intent", "authentication")
    expect(reconcile).not.toHaveBeenCalled()
  } finally {
    reconcile.mockRestore()
    complete.mockRestore()
    fail.mockRestore()
    deleteSession.mockRestore()
    revokeSession.mockRestore()
  }
})

async function beforeCreate(metadata: unknown): Promise<{ data: { metadata: Record<string, unknown> } } | undefined> {
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

test.each([true, false, null, "true", 1, {}, []].map((value) => ({ value })))("public creation strips obsolete gatewayDashboard value %s without retaining enable semantics", async ({ value }) => {
  const metadata = { label: "preserved", capabilities: { gatewayDashboard: value, installLinks: false, otherCapability: "preserved" } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    const result = await beforeCreate(input)
    const organization = { name: "Test Workspace", slug: "test-workspace", metadata: input, ...result?.data }
    expect(organization).toEqual({
      name: "Test Workspace",
      slug: "test-workspace",
      metadata: { label: "preserved", capabilities: { installLinks: false, otherCapability: "preserved" } },
    })
    expect(metadata.capabilities).toHaveProperty("gatewayDashboard", value)
  }
})

test("public creation drops gateway-only metadata through the hook data replacement", async () => {
  const metadata = { capabilities: { gatewayDashboard: false } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    await expect(beforeCreate(input)).resolves.toEqual({ data: { metadata: { capabilities: {} } } })
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
  for (const metadata of [{ dpaSigned: true }, JSON.stringify({ dpaSigned: false }), { dpaSigned: true, capabilities: { gatewayDashboard: true } }]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "dpaSigned is reserved for internal platform administration." },
    })
  }
})

test("public organization creation cannot grant itself a commercial plan or audit entitlement", async () => {
  for (const plan of [null, {}, { tier: "enterprise", source: "manual" }, { tier: "enterprise", source: "stripe" }, { tier: "enterprise", source: "grandfathered" }]) {
    for (const metadata of [{ plan }, JSON.stringify({ plan })]) await expect(beforeCreate(metadata)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "plan is reserved for internal platform administration." },
    })
  }
})

test("public organization updates cannot replace capability metadata", async () => {
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id !== "organization") continue
    for (const metadata of [{}, { capabilities: { auditLogs: true } }, { capabilities: { auditLogs: false } }, { capabilities: { gatewayDashboard: true } }, { capabilities: { gatewayDashboard: false } }, { plan: { tier: "enterprise" } }, { entitlements: { auditLogs: true } }]) {
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
  { name: "copied raw token", token: "raw-invitation-token", email: " Member@Example.Test ", status: "pending", expired: false, verified: false },
  { name: "public invitation id", token: "public-invitation-id", email: "member@example.test", status: "pending", expired: false, verified: false },
  { name: "wrong email", token: "raw-invitation-token", email: "other@example.test", status: "pending", expired: false, verified: false },
  { name: "expired", token: "raw-invitation-token", email: "member@example.test", status: "pending", expired: true, verified: false },
  { name: "canceled", token: "raw-invitation-token", email: "member@example.test", status: "canceled", expired: false, verified: false },
  { name: "ordinary signup", token: "", email: "member@example.test", status: "pending", expired: false, verified: false },
])("invitation possession cannot verify password signup: $name", async ({ token, email, status, expired, verified }) => {
  invitation = { ...invitation, status, expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)) }
  const invoke = createAuthMiddleware(async (context) => auth.options.databaseHooks.user.create.before({
    id: "test-user", name: "Member", email, emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
  }, context))
  const result = await invokeAuthMiddleware(invoke, {
    path: "/sign-up/email",
    request: new Request(`http://127.0.0.1:8790/api/auth/sign-up/email${token ? `?invite=${token}` : ""}`),
    context: await auth.$context,
  })
  expect(result.data.emailVerified).toBe(verified)
  expect(result.data.email).toBe(email.trim().toLowerCase())
})

test.each([
  { token: "raw-invitation-token", email: " Member@Example.Test ", status: "pending", expired: false, allowed: true },
  { token: "public-invitation-id", email: "member@example.test", status: "pending", expired: false, allowed: true },
  { token: "copied-other-token", email: "member@example.test", status: "pending", expired: false, allowed: false },
  { token: "raw-invitation-token", email: "other@example.test", status: "pending", expired: false, allowed: false },
  { token: "raw-invitation-token", email: "member@example.test", status: "pending", expired: true, allowed: false },
  { token: "public-invitation-id", email: "member@example.test", status: "canceled", expired: false, allowed: false },
  { token: "", email: "member@example.test", status: "pending", expired: false, allowed: false },
])("private single-org signup admission: $token / $email / $status / expired=$expired", async ({ token, email, status, expired, allowed }) => {
  invitation = { ...invitation, status, expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)) }
  const result = invokeAuthMiddleware(auth.options.hooks.before, {
    path: "/sign-up/email", body: { email },
    request: new Request(`http://127.0.0.1:8790/api/auth/sign-up/email?invite=${token}`),
    context: await auth.$context,
  })
  if (allowed) await expect(result).resolves.toBeUndefined()
  else await expect(result).rejects.toMatchObject({ status: "FORBIDDEN", body: { message: "Email signup is disabled for this deployment. Use your organization's SSO or a pre-provisioned account to sign in." } })
})

test("SSO requirement still rejects password signup with a valid invitation", async () => {
  invitation = { ...invitation, status: "pending", expiresAt: new Date(Date.now() + 60_000) }
  requireSso = true
  try {
    await expect(invokeAuthMiddleware(auth.options.hooks.before, {
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
      const result = await invokeAuthMiddleware(invoke, {
        path,
        body: { invite: "raw-invitation-token", emailVerified: true },
        request: new Request(`http://127.0.0.1:8790/api/auth${path}`),
        context: await auth.$context,
      })
      expect(result.data.emailVerified).toBe(emailVerified)
    }
  }
})

test("only independently verified users skip email; unverified users get canonical recovery URL", async () => {
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
      await invokeAuthMiddleware(invoke, {
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

test("public creation rejects auditLogs presence, including string metadata and retired flag stripping", async () => {
  for (const auditLogs of [true, false, null, "true", 1, {}, []]) {
    const metadata = { capabilities: { auditLogs, gatewayDashboard: true } }
    for (const input of [metadata, JSON.stringify(metadata)]) await expect(beforeCreate(input)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "capabilities.auditLogs is reserved for internal platform administration." },
    })
  }
})
