import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { createAuthMiddleware } from "better-auth/api"
import { emailOTP, organization } from "better-auth/plugins"
import { z } from "zod"
import { DEN_ACCOUNT_CONFIG } from "../src/account-linking-policy.js"
import { isSsoEmailDomainTrusted, type SsoEmailDomainProvider } from "../src/sso-email-domain-proof.js"
import { startSignedOidcMock, type OidcTokenFailure } from "./sso-signed-oidc-mock.js"

const authOrigin = "http://localhost:3000"
const callbackURL = `${authOrigin}/signed-in`
const providerId = "synthetic-oidc"
const organizationId = "synthetic-organization"
const emailDomainProof = { version: 1, organizationId, providerId, domain: "example.test", method: "dns-txt", verifiedAt: "2026-01-01T00:00:00.000Z" }
const userId = "existing-user"
const subject = "synthetic-subject"
const inDomainEmail = "member@example.test"
const outsideEmail = "member@outside.test"
const now = new Date("2026-01-01T00:00:00Z")

type ProfileSource = {
  name: string
  mode: "userinfo" | "id-token"
  mapping?: { id: string; email: string; emailVerified: string; name: string }
}
const customMapping = { id: "remote_subject", email: "mailbox", emailVerified: "mailbox_verified", name: "full_name" }
const sources: ProfileSource[] = [
  { name: "UserInfo default claims", mode: "userinfo" },
  { name: "UserInfo mapped claims", mode: "userinfo", mapping: customMapping },
  { name: "verified ID token default claims", mode: "id-token" },
  { name: "verified ID token mapped claims", mode: "id-token", mapping: customMapping },
]

type FixtureOptions = {
  claim?: unknown
  email?: string
  existingUser?: "unverified" | "linked-unverified" | "verified"
  providerVerified?: boolean
  domainVerification?: boolean
  legacyTrustEmailVerified?: boolean
  requireLocalEmailVerified?: boolean
  disableAccountLinking?: boolean
  tokenFailure?: OidcTokenFailure
  providerDomain?: string
  providerIssuer?: string
  proof?: unknown
  policy?: "den" | "absent" | "deny" | "throw"
  allowDevelopment?: boolean
  duringExchange?: (provider: { issuer: string; domain: string; domainVerified: boolean; organizationId: string; oidcConfig: string }) => void
  jit?: boolean
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ")
}

function hasSessionCookie(response: Response) {
  return response.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie))
}

async function fixture(t: TestContext, source: ProfileSource, options: FixtureOptions = {}) {
  const email = options.email ?? inDomainEmail
  const claim = "claim" in options ? options.claim : true
  const profile: Record<string, unknown> = { sub: subject, email, name: "Synthetic Member" }
  if (source.mapping) {
    // Conflicting unmapped fields must not supply either the identity or proof.
    profile.sub = "unmapped-subject"
    profile.email = "unmapped@outside.test"
    profile.email_verified = claim !== true
    profile[source.mapping.id] = subject
    profile[source.mapping.email] = email
    profile[source.mapping.name] = "Synthetic Member"
  }
  if (claim !== undefined) profile[source.mapping?.emailVerified ?? "email_verified"] = claim
  const idp = await startSignedOidcMock({
    profile,
    redirectURI: `${authOrigin}/api/auth/sso/callback/${providerId}`,
    tokenFailure: options.tokenFailure,
    tokenIssuer: options.providerIssuer,
    beforeToken: () => options.duringExchange?.(provider),
  })
  t.after(async () => {
    await idp.close()
    assert.deepEqual(idp.errors, [], "the local OIDC mock must complete the protocol without errors")
  })
  const provider = {
    id: "synthetic-provider-row",
    providerId,
    issuer: options.providerIssuer ?? idp.issuer,
    domain: options.providerDomain ?? "example.test",
    domainVerified: options.providerVerified ?? true,
    userId: "synthetic-admin",
    organizationId,
    oidcConfig: JSON.stringify({
      ...idp.config,
      issuer: options.providerIssuer ?? idp.issuer,
      openworkEmailDomainProof: "proof" in options ? options.proof : emailDomainProof,
      mapping: source.mapping,
      ...(source.mode === "userinfo" ? { userInfoEndpoint: `${idp.issuer}/userinfo` } : {}),
    }),
  }
  const data: Record<string, Record<string, unknown>[]> = {
    user: options.existingUser ? [{
      id: userId, email, name: "Existing Member", emailVerified: options.existingUser === "verified", createdAt: now, updatedAt: now,
    }] : [],
    account: options.existingUser ? [{
      id: "existing-account", userId,
      providerId: options.existingUser === "linked-unverified" ? providerId : "credential",
      accountId: options.existingUser === "linked-unverified" ? subject : userId,
      createdAt: now, updatedAt: now,
    }] : [],
    session: [],
    verification: [],
    ssoProvider: [provider],
    organization: [{ id: organizationId, name: "Synthetic Organization", slug: "synthetic", createdAt: now }],
    member: [],
  }
  const policyCalls: SsoEmailDomainProvider[] = []
  const lifecycle: string[] = []
  const emailDomainPolicy = async (input: { provider: SsoEmailDomainProvider; email: string; protocol: "oidc" | "saml" }) => {
    policyCalls.push(structuredClone(input.provider))
    assert.equal(input.protocol, "oidc")
    if (options.policy === "throw") throw new Error("Synthetic domain policy failure")
    if (options.policy === "deny") return false
    return isSsoEmailDomainTrusted(input.provider, input.email, { protocol: input.protocol, allowDevelopment: options.allowDevelopment ?? false })
  }
  const outbox: { email: string; type: string }[] = []
  const validations: (boolean | undefined)[] = []
  const auth = betterAuth({
    baseURL: authOrigin,
    secret: "synthetic-sso-verification-test-secret-not-for-production",
    telemetry: { enabled: false },
    logger: { disabled: true },
    trustedOrigins: [idp.issuer],
    database: memoryAdapter(data),
    // Use Den's real linking policy, not a more permissive test-only policy.
    account: {
      ...DEN_ACCOUNT_CONFIG,
      accountLinking: {
        ...DEN_ACCOUNT_CONFIG.accountLinking,
        ...(options.requireLocalEmailVerified === undefined ? {} : { requireLocalEmailVerified: options.requireLocalEmailVerified }),
        ...(options.disableAccountLinking ? { enabled: false } : {}),
      },
    },
    user: {
      validateUserInfo({ user }) {
        // Observe the supported rejection gate; do not mutate its user object.
        validations.push(user.emailVerified)
      },
    },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (!options.jit || !ctx.path?.startsWith("/sso/callback/") || !ctx.context.newSession) return
        assert.equal(ctx.params?.providerId, providerId)
        const member = data.member.find((row) => row.userId === ctx.context.newSession?.user.id && row.organizationId === organizationId)
        assert.ok(member, "raw organization JIT must precede the real SDK newSession after-hook")
        lifecycle.push("after-session-with-member")
      }),
    },
    plugins: [
      ...(options.jit ? [organization()] : []),
      emailOTP({
        overrideDefaultEmailVerification: true,
        async sendVerificationOTP({ email, type }) {
          outbox.push({ email, type })
        },
      }),
      sso({
        domainVerification: {
          enabled: options.domainVerification ?? true,
          ...(options.policy === "absent" ? {} : { isEmailDomainTrusted: emailDomainPolicy }),
        },
        organizationProvisioning: { disabled: !options.jit },
        provisionUser: async () => { if (options.jit) lifecycle.push("provision") },
        ...(options.legacyTrustEmailVerified === undefined ? {} : { trustEmailVerified: options.legacyTrustEmailVerified }),
      }),
    ],
  })
  const begin = () => auth.handler(new Request(`${authOrigin}/api/auth/sign-in/sso`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: authOrigin },
    body: JSON.stringify({ providerId, email, callbackURL }),
  }))
  const finish = async (start: Response) => {
    assert.equal(start.status, 200, await start.clone().text())
    const { url } = z.object({ url: z.string() }).parse(await start.json())
    assert.equal(new URL(url).origin, idp.issuer, "authorization must stay on the loopback mock")
    const authorization = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) })
    assert.equal(authorization.status, 302, await authorization.text())
    const location = authorization.headers.get("location")
    assert.ok(location)
    assert.equal(new URL(location).origin, authOrigin)
    return auth.handler(new Request(location, { headers: { cookie: cookies(start) } }))
  }
  const signIn = async () => finish(await begin())
  const session = async (callback: Response) => {
    const response = await auth.handler(new Request(`${authOrigin}/api/auth/get-session`, {
      headers: { cookie: cookies(callback) },
    }))
    assert.equal(response.status, 200)
    return z.object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) }).parse(await response.json())
  }
  return { data, provider, outbox, validations, policyCalls, lifecycle, idp, begin, finish, signIn, session }
}

async function assertSignedIn(f: Awaited<ReturnType<typeof fixture>>, response: Response, email: string, emailVerified: boolean) {
  assert.equal(response.status, 302, await response.clone().text())
  assert.equal(response.headers.get("location"), callbackURL)
  assert.equal(hasSessionCookie(response), true)
  assert.equal(f.data.user.length, 1)
  assert.equal(f.data.user[0]?.email, email)
  assert.equal(f.data.user[0]?.emailVerified, emailVerified)
  const session = await f.session(response)
  assert.equal(session.user.email, email)
  assert.equal(session.user.emailVerified, emailVerified)
  assert.equal(session.user.id, f.data.user[0]?.id)
}

function assertNoSession(f: Awaited<ReturnType<typeof fixture>>, response: Response) {
  assert.equal(hasSessionCookie(response), false)
  assert.equal(f.data.session.length, 0)
  assert.deepEqual(f.outbox, [])
}

for (const source of sources) {
  for (const existingUser of [undefined, "unverified"] satisfies (FixtureOptions["existingUser"])[]) {
    const identity = existingUser ? "existing unverified user" : "new user"
    for (const claim of [
      { name: "boolean true", value: true, verified: true },
      { name: "boolean false", value: false, verified: false },
      { name: "missing claim", value: undefined, verified: false },
      { name: "string true", value: "true", verified: false },
      { name: "string false", value: "false", verified: false },
      { name: "number one", value: 1, verified: false },
      { name: "number zero", value: 0, verified: false },
      { name: "null", value: null, verified: false },
      { name: "object", value: { verified: true }, verified: false },
      { name: "array", value: [true], verified: false },
    ]) {
      test(`${source.name}: ${identity}, ${claim.name} controls verification before linking and mail`, async (t) => {
        const f = await fixture(t, source, { existingUser, claim: claim.value })
        const response = await f.signIn()
        await assertSignedIn(f, response, inDomainEmail, claim.verified)
        assert.deepEqual(f.validations, [claim.verified])
        assert.equal(f.data.account.length, existingUser ? 2 : 1)
        assert.equal(f.data.account.filter((account) => account.providerId === providerId).length, 1)
        const linked = f.data.account.find((account) => account.providerId === providerId)
        assert.equal(linked?.accountId, subject)
        assert.equal(linked?.userId, f.data.user[0]?.id)
        if (existingUser) assert.equal(f.data.user[0]?.id, userId)
        assert.deepEqual(f.outbox, !existingUser && !claim.verified ? [{ email: inDomainEmail, type: "email-verification" }] : [])
        assert.deepEqual(f.idp.requests, {
          authorize: 1, token: 1, userinfo: source.mode === "userinfo" ? 1 : 0, jwks: source.mode === "id-token" ? 1 : 0,
        })
      })
    }
  }

  test(`${source.name}: an already-linked unverified user becomes verified without creating another account or sending mail`, async (t) => {
    const f = await fixture(t, source, { existingUser: "linked-unverified" })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, true)
    assert.equal(f.data.user[0]?.id, userId)
    assert.equal(f.data.account.length, 1)
    assert.equal(f.data.account[0]?.id, "existing-account")
    assert.deepEqual(f.outbox, [])
  })

  test(`${source.name}: a verified provider cannot verify a new out-of-domain user`, async (t) => {
    const f = await fixture(t, source, { email: outsideEmail })
    await assertSignedIn(f, await f.signIn(), outsideEmail, false)
    assert.deepEqual(f.outbox, [{ email: outsideEmail, type: "email-verification" }])
  })

  for (const existingUser of ["unverified", "verified"] satisfies (FixtureOptions["existingUser"])[]) {
    test(`${source.name}: no new linked account for an out-of-domain existing ${existingUser} user`, async (t) => {
      const f = await fixture(t, source, { email: outsideEmail, existingUser })
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.signIn()
      assert.equal(response.status, 302)
      assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "account not linked")
      assertNoSession(f, response)
      assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
      assert.deepEqual(f.validations, [])
    })
  }

  test(`${source.name}: an already-linked out-of-domain user is not upgraded`, async (t) => {
    const f = await fixture(t, source, { email: outsideEmail, existingUser: "linked-unverified" })
    await assertSignedIn(f, await f.signIn(), outsideEmail, false)
    assert.equal(f.data.account.length, 1)
    assert.deepEqual(f.outbox, [])
  })

  test(`${source.name}: domain verification must be enabled, not merely present on the provider row`, async (t) => {
    const f = await fixture(t, source, { domainVerification: false })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, false)
    assert.deepEqual(f.outbox, [{ email: inDomainEmail, type: "email-verification" }])
  })

  test(`${source.name}: an unverified provider cannot start sign-in`, async (t) => {
    const f = await fixture(t, source, { providerVerified: false })
    const response = await f.begin()
    assert.equal(response.status, 401)
    assertNoSession(f, response)
    assert.deepEqual(f.data.user, [])
    assert.deepEqual(f.data.account, [])
    assert.deepEqual(f.idp.requests, { authorize: 0, token: 0, userinfo: 0, jwks: 0 })
  })

  for (const existingUser of [undefined, "unverified"] satisfies (FixtureOptions["existingUser"])[]) {
    test(`${source.name}: provider verification revoked before callback cannot create or upgrade ${existingUser ? "an existing user" : "a new user"}`, async (t) => {
      const f = await fixture(t, source, { existingUser })
      const start = await f.begin()
      f.provider.domainVerified = false
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.finish(start)
      assert.equal(response.status, 401)
      assertNoSession(f, response)
      assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
      assert.deepEqual(f.idp.requests, { authorize: 1, token: 0, userinfo: 0, jwks: 0 })
    })
  }

  for (const policy of [
    { name: "local verification required", requireLocalEmailVerified: true },
    { name: "account linking disabled", disableAccountLinking: true },
  ]) {
    test(`${source.name}: verified claim does not override ${policy.name}`, async (t) => {
      const f = await fixture(t, source, { existingUser: "unverified", ...policy })
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.signIn()
      assert.equal(response.status, 302)
      assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "account not linked")
      assertNoSession(f, response)
      assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
    })
  }

  for (const claim of [{ value: "true", verified: true }, { value: "false", verified: false }]) {
    test(`${source.name}: explicit legacy trust retains string ${claim.value} behavior without verified-domain authority`, async (t) => {
      const f = await fixture(t, source, {
        claim: claim.value, email: outsideEmail, providerVerified: false, domainVerification: false, legacyTrustEmailVerified: true, policy: "absent",
      })
      await assertSignedIn(f, await f.signIn(), outsideEmail, claim.verified)
      assert.deepEqual(f.outbox, claim.verified ? [] : [{ email: outsideEmail, type: "email-verification" }])
    })
  }

  test(`${source.name}: absent server policy adds no proof even for a legacy verified provider with a marker`, async (t) => {
    const f = await fixture(t, source, { policy: "absent" })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, false)
    assert.deepEqual(f.policyCalls, [])
    assert.deepEqual(f.outbox, [{ email: inDomainEmail, type: "email-verification" }])
  })

  for (const scenario of [
    { name: "legacy domainVerified without a proof marker", options: { proof: undefined } },
    { name: "email subdomain", options: { email: "member@sub.example.test" } },
    { name: "wildcard domain", options: { providerDomain: "*.example.test" } },
    { name: "comma-separated domains", options: { providerDomain: "example.test,other.test" } },
    { name: "mismatched proof domain", options: { proof: { ...emailDomainProof, domain: "outside.test" } } },
    { name: "cross-organization proof", options: { proof: { ...emailDomainProof, organizationId: "another-org" } } },
    { name: "cross-provider proof", options: { proof: { ...emailDomainProof, providerId: "another-provider" } } },
    { name: "development proof in production", options: { proof: { ...emailDomainProof, method: "development" } } },
    { name: "server policy denial despite global opt-in", options: { policy: "deny", legacyTrustEmailVerified: true } },
    { name: "domain verification disabled despite global opt-in", options: { domainVerification: false, legacyTrustEmailVerified: true } },
  ] satisfies { name: string; options: FixtureOptions }[]) {
    for (const existingUser of [undefined, "unverified"] satisfies FixtureOptions["existingUser"][]) {
      test(`${source.name}: ${scenario.name} cannot verify or implicitly link ${existingUser ? "an existing user" : "a new user"}`, async (t) => {
        const f = await fixture(t, source, { ...scenario.options, existingUser })
        const before = structuredClone({ users: f.data.user, accounts: f.data.account })
        const response = await f.signIn()
        if (existingUser) {
          assert.equal(response.status, 302)
          assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "account not linked")
          assertNoSession(f, response)
          assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
        } else {
          await assertSignedIn(f, response, scenario.options.email ?? inDomainEmail, false)
          assert.equal(f.outbox.length, 1)
        }
      })
    }
  }

  test(`${source.name}: configured proof never accepts string true via the global legacy opt-in`, async (t) => {
    const f = await fixture(t, source, { claim: "true", legacyTrustEmailVerified: true })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, false)
    assert.equal(f.outbox.length, 1)
  })

  test(`${source.name}: development proof requires explicit development permission`, async (t) => {
    const f = await fixture(t, source, { proof: { ...emailDomainProof, method: "development" }, allowDevelopment: true })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, true)
    assert.deepEqual(f.outbox, [])
  })

  test(`${source.name}: rotating an unproven provider domain does not upgrade its preserved linked account`, async (t) => {
    const f = await fixture(t, source, { existingUser: "linked-unverified", email: outsideEmail, providerDomain: "outside.test" })
    await assertSignedIn(f, await f.signIn(), outsideEmail, false)
    assert.equal(f.data.account.length, 1)
    assert.deepEqual(f.outbox, [])
  })

  for (const existingUser of [undefined, "unverified", "linked-unverified"] satisfies FixtureOptions["existingUser"][]) {
    test(`${source.name}: legacy Entra approval and global opt-in cannot grandfather proof after domain rotation (${existingUser ?? "new"})`, async (t) => {
      const f = await fixture(t, source, {
        existingUser, email: outsideEmail, proof: undefined, legacyTrustEmailVerified: true,
        // Issuer metadata only: token, UserInfo and JWKS traffic still uses the
        // local signed mock, never this real service or an external tenant.
        providerIssuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
      })
      f.provider.domain = "outside.test"
      assert.equal(f.provider.domainVerified, true)
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.signIn()
      if (existingUser === "unverified") {
        assert.equal(response.status, 302)
        assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "account not linked")
        assertNoSession(f, response)
        assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
      } else {
        await assertSignedIn(f, response, outsideEmail, false)
        assert.equal(f.data.account.length, 1)
        if (existingUser) assert.equal(f.data.account[0]?.id, "existing-account")
        assert.equal(f.outbox.length, existingUser ? 0 : 1)
      }
    })
  }

  test(`${source.name}: independently verified local users are not downgraded by a denied proof`, async (t) => {
    const f = await fixture(t, source, { existingUser: "verified", policy: "deny" })
    f.data.account[0] = { ...f.data.account[0], providerId, accountId: subject }
    await assertSignedIn(f, await f.signIn(), inDomainEmail, true)
    assert.equal(f.data.account.length, 1)
    assert.deepEqual(f.outbox, [])
  })

  for (const existingUser of [undefined, "unverified", "linked-unverified"] satisfies FixtureOptions["existingUser"][]) {
    test(`${source.name}: throwing domain policy aborts before identity writes or mail (${existingUser ?? "new"})`, async (t) => {
      const f = await fixture(t, source, { existingUser, policy: "throw", legacyTrustEmailVerified: true })
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.signIn()
      assert.equal(response.status, 500)
      assertNoSession(f, response)
      assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
      assert.equal(f.policyCalls.length, 1)
      assert.deepEqual(f.validations, [])
    })
  }

  for (const mutation of [
    { name: "domain", apply: (p) => { p.domain = "outside.test" } },
    { name: "organization", apply: (p) => { p.organizationId = "another-org" } },
    { name: "legacy verification flag", apply: (p) => { p.domainVerified = false } },
    { name: "issuer", apply: (p) => { p.issuer += "/changed" } },
    { name: "proof removal", apply: (p) => {
      const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.oidcConfig))
      delete config.openworkEmailDomainProof
      p.oidcConfig = JSON.stringify(config)
    } },
    { name: "verification claim mapping", apply: (p) => {
      const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.oidcConfig))
      p.oidcConfig = JSON.stringify({ ...config, mapping: { ...source.mapping, emailVerified: "another_claim" } })
    } },
    { name: "client secret", apply: (p) => {
      const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.oidcConfig))
      p.oidcConfig = JSON.stringify({ ...config, clientSecret: "rotated-secret" })
    } },
  ] satisfies { name: string; apply: NonNullable<FixtureOptions["duringExchange"]> }[]) {
    test(`${source.name}: changing ${mutation.name} during token exchange aborts before linking, verification or mail`, async (t) => {
      const f = await fixture(t, source, { existingUser: "unverified", duringExchange: mutation.apply })
      const before = structuredClone({ users: f.data.user, accounts: f.data.account })
      const response = await f.signIn()
      assert.equal(response.status, 302)
      assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "SSO_PROVIDER_CHANGED")
      assertNoSession(f, response)
      assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
      assert.deepEqual(f.policyCalls, [])
      assert.deepEqual(f.validations, [])
    })
  }

  test(`${source.name}: real newSession after-hook runs after organization JIT`, async (t) => {
    const f = await fixture(t, source, { jit: true })
    await assertSignedIn(f, await f.signIn(), inDomainEmail, true)
    assert.deepEqual(f.lifecycle, ["provision", "after-session-with-member"])
    assert.equal(f.data.member.length, 1)
    assert.equal(f.data.member[0]?.userId, f.data.user[0]?.id)
  })

  if (source.mode === "id-token") {
    for (const tokenFailure of ["signature", "audience", "issuer", "expired"] satisfies OidcTokenFailure[]) {
      for (const existingUser of [undefined, "unverified"] satisfies (FixtureOptions["existingUser"])[]) {
        test(`${source.name}: wrong ${tokenFailure} cannot create, link, verify or mail ${existingUser ? "an existing user" : "a new user"}`, async (t) => {
          const f = await fixture(t, source, { tokenFailure, existingUser })
          const before = structuredClone({ users: f.data.user, accounts: f.data.account })
          const response = await f.signIn()
          assert.equal(response.status, 302)
          const location = new URL(response.headers.get("location") ?? "", authOrigin)
          assert.equal(location.searchParams.get("error"), "invalid_provider")
          assert.equal(location.searchParams.get("error_description"), "token_not_verified")
          assertNoSession(f, response)
          assert.deepEqual({ users: f.data.user, accounts: f.data.account }, before)
          assert.deepEqual(f.validations, [])
          assert.deepEqual(f.idp.requests, { authorize: 1, token: 1, userinfo: 0, jwks: 1 })
        })
      }
    }
  }
}
