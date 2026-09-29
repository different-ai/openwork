import assert from "node:assert/strict"
import { beforeAll, test } from "bun:test"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { withSsoEmailDomainProof } from "../src/sso-email-domain-proof.js"
import { seedDatabaseTestEnv } from "./database-test-env.js"
import { startSignedOidcMock } from "./sso-signed-oidc-mock.js"

let denAuth: typeof import("../src/auth.js").auth
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let createDenDb: typeof import("@openwork-ee/den-db").createDenDb
let seedRoles: typeof import("../src/orgs.js").seedDefaultOrganizationRoles
let authOrigin: string
let databaseUrl: string

beforeAll(async () => {
  databaseUrl = seedDatabaseTestEnv()
  // This is a MySQL/MariaDB lock test, never a hosted PlanetScale connection.
  process.env.DB_MODE = "mysql"
  const modules = await Promise.all([
    import("../src/auth.js"), import("../src/db.js"), import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db"), import("../src/orgs.js"), import("../src/env.js"),
  ])
  denAuth = modules[0].auth
  // Finish the real instance's resource seeding before creating the instrumented
  // instance with the same plugins and database.
  await denAuth.$context
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  createDenDb = modules[4].createDenDb
  seedRoles = modules[5].seedDefaultOrganizationRoles
  assert.equal(modules[6].env.dbMode, "mysql")
  authOrigin = modules[6].env.betterAuthUrl
})

function barrier() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// Watchdogs bound broken callbacks; elapsed time is never our lock witness.
async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 15_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isLockWaitTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("code" in error && error.code === "ER_LOCK_WAIT_TIMEOUT" && "errno" in error && error.errno === 1205) return true
  return "cause" in error && isLockWaitTimeout(error.cause)
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]?.trim()).filter(Boolean).join("; ")
}

for (const identity of ["new user", "unlinked-unverified", "linked-unverified"]) {
  test(`Den retains the SSO provider lock through identity writes: ${identity}`, async () => {
    const organizationId = createDenTypeId("organization")
    const ownerId = createDenTypeId("user")
    const existingUserId = createDenTypeId("user")
    const providerRowId = createDenTypeId("ssoProvider")
    const providerId = `sso-race-${organizationId}`
    const domain = "sso-provider-transaction.test"
    const email = `member+${organizationId}@${domain}`
    const subject = `subject-${organizationId}`
    const callbackURL = new URL("/signed-in", authOrigin).toString()
    const reached = barrier()
    const resume = barrier()
    const validationActions: string[] = []
    let callback: Promise<Response> | undefined
    let state: string | null = null
    const idp = await startSignedOidcMock({
      profile: { sub: subject, email, name: "SSO transaction member", email_verified: true },
      redirectURI: `${authOrigin}/api/auth/sso/callback/${providerId}`,
    })
    // A separate pool ensures the contending writer cannot reuse the callback's
    // connection. Its short session timeout cannot leak into Den's pooled sessions.
    const writer = createDenDb({ databaseUrl, mode: "mysql" })
    const oidcConfig = withSsoEmailDomainProof({ ...idp.config, skipDiscovery: true }, {
      version: 1, organizationId, providerId, domain, method: "dns-txt", verifiedAt: new Date().toISOString(),
    })
    const replacement = { domain: "replacement.sso-provider-transaction.test", domainVerified: false, oidcConfig: withSsoEmailDomainProof(oidcConfig, null) }
    const replaceProvider = () => writer.db.transaction(async (tx) => {
      await tx.execute(drizzle.sql`SET SESSION innodb_lock_wait_timeout = 1`)
      await tx.update(schema.SsoProviderTable).set(replacement).where(drizzle.eq(schema.SsoProviderTable.id, providerRowId))
    })
    const cleanup = async () => {
      const users = await db.select({ id: schema.AuthUserTable.id }).from(schema.AuthUserTable)
        .where(drizzle.or(drizzle.eq(schema.AuthUserTable.id, ownerId), drizzle.eq(schema.AuthUserTable.email, email)))
      const userIds = users.map((user) => user.id)
      if (userIds.length) {
        await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.userId, userIds))
        await db.delete(schema.AuthAccountTable).where(drizzle.inArray(schema.AuthAccountTable.userId, userIds))
      }
      if (state) await db.delete(schema.AuthVerificationTable).where(drizzle.eq(schema.AuthVerificationTable.identifier, state))
      await db.delete(schema.ExternalIdentityTable).where(drizzle.eq(schema.ExternalIdentityTable.organizationId, organizationId))
      await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
      await db.delete(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.organizationId, organizationId))
      await db.delete(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.organizationId, organizationId))
      await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
      await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
      if (userIds.length) await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, userIds))
    }

    try {
      await db.insert(schema.AuthUserTable).values({ id: ownerId, email: `${ownerId}@${domain}`, name: "SSO transaction owner", emailVerified: true })
      await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "SSO transaction workspace", slug: providerId })
      await seedRoles(organizationId)
      await db.insert(schema.MemberTable).values({ id: createDenTypeId("member"), organizationId, userId: ownerId, role: "owner" })
      await db.insert(schema.SsoProviderTable).values({
        id: providerRowId, providerId, organizationId, userId: ownerId,
        issuer: idp.issuer, domain, domainVerified: true, oidcConfig,
      })
      await db.insert(schema.SsoConnectionTable).values({
        id: createDenTypeId("ssoConnection"), organizationId, providerId, kind: "oidc", issuer: idp.issuer, domain,
        status: "enabled", signInPath: `/sso/${providerId}`, configRevision: "transaction-fixture", testStatus: "succeeded", lastTestedRevision: "transaction-fixture",
      })
      if (identity !== "new user") {
        await db.insert(schema.AuthUserTable).values({ id: existingUserId, email, name: "Existing SSO member", emailVerified: false })
        await db.insert(schema.AuthAccountTable).values({
          id: createDenTypeId("account"), userId: existingUserId,
          providerId: identity === "linked-unverified" ? providerId : "credential",
          accountId: identity === "linked-unverified" ? subject : existingUserId,
        })
      }

      const denOptions: BetterAuthOptions = denAuth.options
      const instrumented = betterAuth({
        ...denOptions,
        // Only the generated local IdP transport is added; all Den plugins,
        // database hooks, linking/proof policies and the actual adapter remain.
        trustedOrigins: [...(denAuth.options.trustedOrigins ?? []), idp.issuer],
        user: {
          ...denOptions.user,
          async validateUserInfo(data, context) {
            const result = await denOptions.user?.validateUserInfo?.(data, context)
            if (result?.error) return result
            if (data.source.method === "sso-oidc" && data.source.sso?.providerId === providerId) {
              assert.equal(data.user.emailVerified, true, "the real Den domain-proof policy must have accepted the signed profile")
              validationActions.push(data.source.action)
              // The SDK calls this after its provider check, before creating a
              // user, linking an account, or upgrading an already-linked user.
              reached.resolve()
              await resume.promise
            }
            return result
          },
        },
      })
      assert.equal(instrumented.options.database, denAuth.options.database, "never substitute a test-only transaction-enabled adapter")
      const start = await instrumented.handler(new Request(`${authOrigin}/api/auth/sign-in/sso`, {
        method: "POST", headers: { "content-type": "application/json", origin: new URL(authOrigin).origin },
        body: JSON.stringify({ providerId, email, callbackURL }),
      }))
      assert.equal(start.status, 200, await start.clone().text())
      const { url } = z.object({ url: z.string() }).parse(await start.json())
      assert.equal(new URL(url).origin, idp.issuer)
      state = new URL(url).searchParams.get("state")
      assert.ok(state)
      const authorization = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) })
      assert.equal(authorization.status, 302, await authorization.text())
      const location = authorization.headers.get("location")
      assert.ok(location)
      assert.equal(new URL(location).origin, new URL(authOrigin).origin)
      callback = instrumented.handler(new Request(location, { headers: { cookie: cookies(start) } }))
      await deadline(Promise.race([
        reached.promise,
        callback.then(async (response) => { throw new Error(`Callback completed before the identity barrier: ${response.status} ${response.headers.get("location")} ${await response.text()}`) }),
      ]), "SSO identity validation barrier")
      assert.deepEqual(validationActions, [identity === "new user" ? "create-user" : identity === "unlinked-unverified" ? "link-account" : "sign-in"])
      const before = await db.select().from(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.email, email))
      assert.equal(before.length, identity === "new user" ? 0 : 1)
      if (before[0]) assert.equal(before[0].emailVerified, false)
      const accountsBefore = await db.select().from(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.providerId, providerId))
      assert.equal(accountsBefore.length, identity === "linked-unverified" ? 1 : 0)

      // This must fail with the database's actual lock-timeout error. With
      // Den's transaction option removed/false, the UPDATE succeeds and the
      // assertion fails immediately, even though the callback stays paused.
      await assert.rejects(deadline(replaceProvider(), "contending provider UPDATE"), isLockWaitTimeout)
      const [stillTrusted] = await db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.id, providerRowId))
      assert.equal(stillTrusted?.domain, domain)
      assert.equal(stillTrusted?.domainVerified, true)
      assert.equal(stillTrusted?.oidcConfig, oidcConfig)

      resume.resolve()
      const response = await deadline(callback, "SSO callback after releasing the identity barrier")
      assert.equal(response.status, 302, await response.clone().text())
      assert.equal(response.headers.get("location"), callbackURL)
      assert.ok(response.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie)))
      const users = await db.select().from(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.email, email))
      assert.equal(users.length, 1)
      const user = users[0]
      assert.ok(user)
      assert.equal(user.emailVerified, true)
      if (identity !== "new user") assert.equal(user.id, existingUserId)
      const accounts = await db.select().from(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.providerId, providerId))
      assert.equal(accounts.length, 1)
      assert.equal(accounts[0]?.userId, user.id)
      assert.equal(accounts[0]?.accountId, subject)
      const sessions = await db.select().from(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.userId, user.id))
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0]?.activeOrganizationId, null, "Den's SSO session hook must not bootstrap inside the account-link transaction")
      const members = await db.select().from(schema.MemberTable).where(drizzle.and(
        drizzle.eq(schema.MemberTable.organizationId, organizationId), drizzle.eq(schema.MemberTable.userId, user.id), drizzle.isNull(schema.MemberTable.removedAt),
      ))
      assert.equal(members.length, 1, "real SDK JIT and Den's callback hooks must finish after the account-link transaction commits")
      const identities = await db.select().from(schema.ExternalIdentityTable).where(drizzle.and(
        drizzle.eq(schema.ExternalIdentityTable.organizationId, organizationId), drizzle.eq(schema.ExternalIdentityTable.userId, user.id),
      ))
      assert.equal(identities.length, 1, "keep Den's real provisionUser hook")
      assert.deepEqual(idp.requests, { authorize: 1, token: 1, userinfo: 0, jwks: 1 })
      assert.deepEqual(idp.errors, [])

      await deadline(replaceProvider(), "provider UPDATE after the callback commits")
      const [replaced] = await db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.id, providerRowId))
      assert.equal(replaced?.domain, replacement.domain)
      assert.equal(replaced?.domainVerified, false)
      assert.equal(replaced?.oidcConfig, replacement.oidcConfig)
    } finally {
      resume.resolve()
      try {
        if (callback) await deadline(callback, "settling callback before fixture cleanup")
      } finally {
        try {
          await cleanup()
        } finally {
          try {
            await idp.close()
          } finally {
            if ("end" in writer.client) await writer.client.end()
          }
        }
      }
    }
  }, 45_000)
}
