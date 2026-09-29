import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { sso } from "@better-auth/sso"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { createAuthMiddleware } from "better-auth/api"
import { emailOTP, organization } from "better-auth/plugins"
import { z } from "zod"
import { DEN_ACCOUNT_CONFIG } from "../src/account-linking-policy.js"
import { isSsoEmailDomainTrusted, type SsoEmailDomainProvider } from "../src/sso-email-domain-proof.js"
import { signedSamlFixture, type SamlAttribute, type SamlResponseOptions } from "./sso-signed-saml-fixture.js"

const authOrigin = "http://localhost:3000"
const callbackURL = `${authOrigin}/signed-in`
const providerId = "synthetic-saml"
const organizationId = "synthetic-organization"
const userId = "existing-user"
const email = "member@example.test"
const now = new Date("2026-01-01T00:00:00Z")
const proof = { version: 1, organizationId, providerId, domain: "example.test", method: "dns-txt", verifiedAt: now.toISOString() }

type Provider = {
  id: string
  providerId: string
  userId: string
  issuer: string
  domain: string
  domainVerified: boolean
  organizationId: string
  samlConfig: string
}
type FixtureOptions = {
  idpIssuer?: string
  email?: string
  existingUser?: "unverified" | "linked-unverified" | "linked-verified"
  attributes?: SamlAttribute[]
  verificationMapping?: string
  proof?: unknown
  providerDomain?: string
  providerVerified?: boolean
  policy?: "den" | "absent" | "deny" | "throw"
  allowDevelopment?: boolean
  domainVerification?: boolean
  legacyTrustEmailVerified?: boolean
  requireLocalEmailVerified?: boolean
  disableAccountLinking?: boolean
  beforeLock?: (provider: Provider) => void
  jit?: boolean
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]?.trim() ?? "").filter(Boolean).join("; ")
}
function hasSession(response: Response) {
  return response.headers.getSetCookie().some((cookie) => /session_token=[^;]+/.test(cookie))
}

function fixture(options: FixtureOptions = {}) {
  const idp = signedSamlFixture(options.idpIssuer)
  const userEmail = options.email ?? email
  const provider: Provider = {
    id: "synthetic-provider-row", providerId, userId: "synthetic-admin", issuer: idp.config.issuer,
    domain: options.providerDomain ?? "example.test", domainVerified: options.providerVerified ?? true, organizationId,
    samlConfig: JSON.stringify({
      ...idp.config,
      openworkEmailDomainProof: "proof" in options ? options.proof : proof,
      mapping: options.verificationMapping === undefined ? undefined : { emailVerified: options.verificationMapping },
    }),
  }
  const linked = options.existingUser?.startsWith("linked-")
  const data: Record<string, Record<string, unknown>[]> = {
    user: options.existingUser ? [{ id: userId, email: userEmail, name: "Existing Member", emailVerified: options.existingUser === "linked-verified", createdAt: now, updatedAt: now }] : [],
    account: options.existingUser ? [{ id: "existing-account", userId, accountId: linked ? userEmail : userId, providerId: linked ? providerId : "credential", createdAt: now, updatedAt: now }] : [],
    session: [], verification: [], ssoProvider: [provider], member: [],
    organization: [{ id: organizationId, name: "Synthetic Organization", slug: "synthetic", createdAt: now }],
  }
  const outbox: { email: string; type: string }[] = []
  const validations: (boolean | undefined)[] = []
  const policyCalls: SsoEmailDomainProvider[] = []
  const lifecycle: string[] = []
  const memory = memoryAdapter(data)
  let callbackInProgress = false
  let providerResolved = false
  let mutationApplied = false
  const emailDomainPolicy = async (input: { provider: SsoEmailDomainProvider; email: string; protocol: "oidc" | "saml" }) => {
    assert.equal(input.protocol, "saml")
    policyCalls.push(structuredClone(input.provider))
    if (options.policy === "throw") throw new Error("Synthetic domain policy failure")
    if (options.policy === "deny") return false
    return isSsoEmailDomainTrusted(input.provider, input.email, { protocol: input.protocol, allowDevelopment: options.allowDevelopment ?? false })
  }
  const auth = betterAuth({
    baseURL: authOrigin,
    secret: "synthetic-saml-verification-test-secret-not-for-production",
    telemetry: { enabled: false }, logger: { disabled: true },
    database: (config: Parameters<typeof memory>[0]) => new Proxy(memory(config), {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver)
        if (key === "findOne" && typeof value === "function") return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(value, target, args)
          const first = args[0]
          if (callbackInProgress && typeof first === "object" && first !== null && "model" in first && first.model === "ssoProvider") providerResolved = true
          return result
        }
        if (key === "transaction" && typeof value === "function") return (...args: unknown[]) => {
          // A concurrent commit must precede the memory adapter's transaction
          // snapshot; its transaction returns a separate adapter instance.
          if (providerResolved && !mutationApplied) {
            options.beforeLock?.(provider)
            mutationApplied = true
          }
          return Reflect.apply(value, target, args)
        }
        if (key === "create" && typeof value === "function") return (...args: unknown[]) => {
          const first = args[0]
          // SQL enforces primary-key uniqueness; memoryAdapter does not. Model
          // that database constraint so the SDK's real replay reservation runs.
          if (typeof first === "object" && first !== null && "model" in first && typeof first.model === "string" && "data" in first && typeof first.data === "object" && first.data !== null && "id" in first.data) {
            const id = first.data.id
            if (id !== undefined && data[first.model]?.some((row) => row.id === id)) throw new Error("Duplicate primary key")
          }
          return Reflect.apply(value, target, args)
        }
        return value
      },
    }),
    account: { ...DEN_ACCOUNT_CONFIG, accountLinking: {
      ...DEN_ACCOUNT_CONFIG.accountLinking,
      ...(options.requireLocalEmailVerified === undefined ? {} : { requireLocalEmailVerified: options.requireLocalEmailVerified }),
      ...(options.disableAccountLinking ? { enabled: false } : {}),
    } },
    user: { validateUserInfo({ user }) { validations.push(user.emailVerified) } },
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true },
    hooks: { after: createAuthMiddleware(async (ctx) => {
      if (!options.jit || !ctx.path?.startsWith("/sso/saml2/sp/acs/") || !ctx.context.newSession) return
      assert.equal(ctx.params?.providerId, providerId)
      assert.ok(data.member.find((row) => row.userId === ctx.context.newSession?.user.id && row.organizationId === organizationId), "raw JIT must precede the SDK newSession after-hook")
      lifecycle.push("after-session-with-member")
    }) },
    plugins: [
      ...(options.jit ? [organization()] : []),
      emailOTP({ overrideDefaultEmailVerification: true, async sendVerificationOTP({ email, type }) { outbox.push({ email, type }) } }),
      sso({
        domainVerification: {
          enabled: options.domainVerification ?? true,
          ...(options.policy === "absent" ? {} : { isEmailDomainTrusted: emailDomainPolicy }),
        },
        ...(options.legacyTrustEmailVerified === undefined ? {} : { trustEmailVerified: options.legacyTrustEmailVerified }),
        saml: { enableInResponseToValidation: true, allowIdpInitiated: false, requireTimestamps: true, clockSkew: 0, algorithms: { onDeprecated: "reject" } },
        organizationProvisioning: { disabled: !options.jit },
        provisionUser: async () => { if (options.jit) lifecycle.push("provision") },
      }),
    ],
  })
  const begin = () => auth.handler(new Request(`${authOrigin}/api/auth/sign-in/sso`, {
    method: "POST", headers: { origin: authOrigin, "content-type": "application/json" },
    body: JSON.stringify({ providerId, providerType: "saml", email: userEmail, callbackURL }),
  }))
  const finish = async (start: Response, responseOptions: Partial<SamlResponseOptions> = {}) => {
    assert.equal(start.status, 200, await start.clone().text())
    const authorization = z.object({ url: z.string() }).parse(await start.json())
    const signed = idp.response(authorization.url, { email: userEmail, attributes: options.attributes, ...responseOptions })
    assert.equal(new URL(signed.acs).origin, authOrigin)
    callbackInProgress = true
    return auth.handler(new Request(signed.acs, {
      method: "POST", headers: { cookie: cookies(start), "content-type": "application/x-www-form-urlencoded" }, body: signed.body,
    }))
  }
  const signIn = async (responseOptions: Partial<SamlResponseOptions> = {}) => finish(await begin(), responseOptions)
  const session = async (callback: Response) => {
    const response = await auth.handler(new Request(`${authOrigin}/api/auth/get-session`, { headers: { cookie: cookies(callback) } }))
    assert.equal(response.status, 200)
    return z.object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) }).parse(await response.json())
  }
  return { auth, data, provider, outbox, validations, policyCalls, lifecycle, begin, finish, signIn, session }
}

async function assertSignedIn(f: ReturnType<typeof fixture>, response: Response, expectedEmail: string, verified: boolean) {
  assert.equal(response.status, 302, await response.clone().text())
  assert.equal(response.headers.get("location"), callbackURL)
  assert.equal(hasSession(response), true)
  assert.equal(f.data.user.length, 1)
  assert.equal(f.data.user[0]?.email, expectedEmail)
  assert.equal(f.data.user[0]?.emailVerified, verified)
  const session = await f.session(response)
  assert.equal(session.user.emailVerified, verified)
  assert.equal(session.user.email, expectedEmail)
  assert.equal(session.user.id, f.data.user[0]?.id)
}

function identityState(f: ReturnType<typeof fixture>) {
  return structuredClone({ users: f.data.user, accounts: f.data.account, sessions: f.data.session })
}
function assertRejected(f: ReturnType<typeof fixture>, response: Response, before: ReturnType<typeof identityState>) {
  assert.equal(hasSession(response), false)
  if (response.status === 302) assert.ok(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "a rejection redirect must explain the error")
  else assert.ok(response.status >= 400, `Expected a rejection, got HTTP ${response.status}`)
  assert.deepEqual(identityState(f), before)
  assert.deepEqual(f.outbox, [])
}

for (const signature of ["assertion", "response"] satisfies NonNullable<SamlResponseOptions["signature"]>[]) {
  for (const existingUser of [undefined, "unverified", "linked-unverified"] satisfies FixtureOptions["existingUser"][]) {
    test(`SAML ${signature} signature: genuine domain proof and authenticated email verify ${existingUser ?? "new user"} without an email_verified attribute`, async () => {
      const f = fixture({ existingUser })
      await assertSignedIn(f, await f.signIn({ signature }), email, true)
      assert.deepEqual(f.validations, [true])
      assert.equal(f.data.account.length, existingUser === "unverified" ? 2 : 1)
      if (existingUser) assert.equal(f.data.user[0]?.id, userId)
      assert.equal(f.policyCalls.length, 1)
      assert.deepEqual(f.outbox, [])
    })
  }

  for (const claim of [
    { name: "true", values: ["true"], verified: true },
    { name: "false", values: ["false"], verified: false },
    { name: "uppercase TRUE", values: ["TRUE"], verified: false },
    { name: "number one", values: ["1"], verified: false },
    { name: "null", values: [null], verified: false },
    { name: "empty value", values: [""], verified: false },
    { name: "multiple conflicting values", values: ["true", "false"], verified: false },
    { name: "multiple true values", values: ["true", "true"], verified: false },
  ] satisfies { name: string; values: (string | null)[]; verified: boolean }[]) {
    for (const verificationMapping of [undefined, "mailbox_verified"]) {
      test(`SAML ${signature} signature: ${verificationMapping ? "mapped" : "standard"} ${claim.name} is honored before mail`, async () => {
        const f = fixture({ verificationMapping, attributes: [{ name: verificationMapping ?? "email_verified", values: claim.values }] })
        await assertSignedIn(f, await f.signIn({ signature }), email, claim.verified)
        assert.deepEqual(f.validations, [claim.verified])
        assert.deepEqual(f.outbox, claim.verified ? [] : [{ email, type: "email-verification" }])
      })
    }
  }

  for (const verificationMapping of ["mailbox_verified", ""]) {
    test(`SAML ${signature} signature: missing configured mapping ${JSON.stringify(verificationMapping)} never falls back to the signed-email default`, async () => {
      const f = fixture({ verificationMapping, attributes: [{ name: "email_verified", values: ["true"] }] })
      await assertSignedIn(f, await f.signIn({ signature }), email, false)
      assert.equal(f.outbox.length, 1)
    })
  }

  test(`SAML ${signature} signature: duplicate verification attributes remain ambiguous even when one is empty`, async () => {
    const f = fixture({ attributes: [{ name: "email_verified", values: [] }, { name: "email_verified", values: ["true"] }] })
    await assertSignedIn(f, await f.signIn({ signature }), email, false)
    assert.equal(f.outbox.length, 1)
  })

  for (const invalid of [
    { name: "bad signature", response: { tamperSignature: true } },
    { name: "wrong certificate", response: { wrongCertificate: true } },
    { name: "wrong issuer", response: { issuer: "http://127.0.0.1/wrong-issuer" } },
    { name: "wrong audience", response: { audience: "https://another-service.example.test" } },
    { name: "wrong recipient", response: { recipient: `${authOrigin}/wrong-acs` } },
    { name: "expired conditions", response: { expired: true } },
    { name: "wrong correlation", response: { inResponseTo: "_unissued-request" } },
  ] satisfies { name: string; response: Partial<SamlResponseOptions> }[]) {
    for (const existingUser of [undefined, "unverified"] satisfies FixtureOptions["existingUser"][]) {
      test(`SAML ${signature} signature: ${invalid.name} cannot create, link, verify or mail ${existingUser ?? "new user"}`, async () => {
        const f = fixture({ existingUser })
        const before = identityState(f)
        assertRejected(f, await f.signIn({ signature, ...invalid.response }), before)
        assert.deepEqual(f.policyCalls, [], "domain proof is consulted only after cryptographic/protocol validation")
        assert.deepEqual(f.validations, [])
      })
    }
  }

  test(`SAML ${signature} signature: a replayed assertion ID is rejected despite fresh valid correlation`, async () => {
    const f = fixture()
    const assertionId = `_${randomUUID()}`
    await assertSignedIn(f, await f.signIn({ signature, assertionId }), email, true)
    const before = identityState(f)
    const response = await f.signIn({ signature, assertionId })
    assertRejected(f, response, before)
    assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "replay_detected")
    assert.equal(f.policyCalls.length, 1)
  })
}

test("SAML unsigned selected identity is rejected before domain authority or identity writes", async () => {
  const f = fixture()
  const before = identityState(f)
  assertRejected(f, await f.signIn({ signature: "none" }), before)
  assert.deepEqual(f.policyCalls, [])
})

for (const scenario of [
  { name: "legacy verified flag without proof", options: { proof: undefined } },
  { name: "subdomain", options: { email: "member@sub.example.test" } },
  { name: "outside domain", options: { email: "member@outside.test" } },
  { name: "wildcard provider domain", options: { providerDomain: "*.example.test" } },
  { name: "comma-separated provider domains", options: { providerDomain: "example.test,other.test" } },
  { name: "mismatched proof domain", options: { proof: { ...proof, domain: "outside.test" } } },
  { name: "cross-organization proof", options: { proof: { ...proof, organizationId: "another-org" } } },
  { name: "cross-provider proof", options: { proof: { ...proof, providerId: "another-provider" } } },
  { name: "development proof in production", options: { proof: { ...proof, method: "development" } } },
  { name: "development proof for a remote IdP behind a local SP", options: { proof: { ...proof, method: "development" }, allowDevelopment: true, idpIssuer: "https://idp.example.test" } },
  { name: "configured policy denial despite global opt-in", options: { policy: "deny", legacyTrustEmailVerified: true } },
  { name: "domain verification disabled despite global opt-in", options: { domainVerification: false, legacyTrustEmailVerified: true } },
] satisfies { name: string; options: FixtureOptions }[]) {
  for (const existingUser of [undefined, "unverified", "linked-unverified"] satisfies FixtureOptions["existingUser"][]) {
    test(`SAML ${scenario.name} cannot verify or implicitly link ${existingUser ?? "new user"}`, async () => {
      const f = fixture({ ...scenario.options, existingUser, verificationMapping: "mailbox_verified", attributes: [{ name: "mailbox_verified", values: ["true"] }] })
      const before = identityState(f)
      const response = await f.signIn()
      if (existingUser === "unverified") {
        assertRejected(f, response, before)
        assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "account_not_linked")
      } else {
        await assertSignedIn(f, response, scenario.options.email ?? email, false)
        assert.equal(f.data.account.length, 1)
        assert.equal(f.outbox.length, existingUser ? 0 : 1)
      }
    })
  }
}

for (const existingUser of [undefined, "unverified", "linked-unverified"] satisfies FixtureOptions["existingUser"][]) {
  test(`SAML throwing policy rejects ${existingUser ?? "new user"} before identity mutation even with global opt-in`, async () => {
    const f = fixture({ existingUser, policy: "throw", legacyTrustEmailVerified: true, verificationMapping: "email_verified", attributes: [{ name: "email_verified", values: ["true"] }] })
    const before = identityState(f)
    const response = await f.signIn()
    assert.equal(response.status, 500)
    assertRejected(f, response, before)
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
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.samlConfig))
    delete config.openworkEmailDomainProof
    p.samlConfig = JSON.stringify(config)
  } },
  { name: "verification mapping", apply: (p) => {
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.samlConfig))
    p.samlConfig = JSON.stringify({ ...config, mapping: { emailVerified: "another_claim" } })
  } },
  { name: "signing certificate", apply: (p) => {
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(p.samlConfig))
    p.samlConfig = JSON.stringify({ ...config, cert: "rotated-certificate" })
  } },
] satisfies { name: string; apply: NonNullable<FixtureOptions["beforeLock"]> }[]) {
  test(`SAML ${mutation.name} changing before row lock aborts before user/account mutation`, async () => {
    const f = fixture({ existingUser: "unverified", beforeLock: mutation.apply })
    const before = identityState(f)
    const response = await f.signIn()
    assertRejected(f, response, before)
    assert.equal(new URL(response.headers.get("location") ?? "", authOrigin).searchParams.get("error"), "SSO_PROVIDER_CHANGED")
    assert.deepEqual(f.policyCalls, [])
  })
}

test("SAML independently verified local identity is not downgraded by a denied claim or domain proof", async () => {
  const f = fixture({ existingUser: "linked-verified", policy: "deny", attributes: [{ name: "email_verified", values: ["false"] }] })
  await assertSignedIn(f, await f.signIn(), email, true)
  assert.equal(f.data.account.length, 1)
  assert.deepEqual(f.outbox, [])
})

test("SAML development marker works only with explicit development permission and loopback issuer", async () => {
  const f = fixture({ proof: { ...proof, method: "development" }, allowDevelopment: true })
  await assertSignedIn(f, await f.signIn(), email, true)
  assert.deepEqual(f.outbox, [])
})

test("SAML legacy verified provider and marker alone add no email proof when server policy is absent", async () => {
  const f = fixture({ policy: "absent" })
  await assertSignedIn(f, await f.signIn(), email, false)
  assert.equal(f.outbox.length, 1)
})

for (const value of ["true", "false"]) {
  test(`SAML absent policy preserves explicit legacy mapped ${value} behavior`, async () => {
    const f = fixture({ policy: "absent", domainVerification: false, providerVerified: false, legacyTrustEmailVerified: true, verificationMapping: "mailbox_verified", attributes: [{ name: "mailbox_verified", values: [value] }] })
    await assertSignedIn(f, await f.signIn(), email, value === "true")
    assert.equal(f.outbox.length, value === "true" ? 0 : 1)
  })
}

for (const policy of [
  { name: "local verification required", requireLocalEmailVerified: true },
  { name: "account linking disabled", disableAccountLinking: true },
]) {
  test(`SAML genuine email proof cannot override ${policy.name}`, async () => {
    const f = fixture({ existingUser: "unverified", ...policy })
    const before = identityState(f)
    assertRejected(f, await f.signIn(), before)
  })
}

test("SAML unverified provider cannot start authentication", async () => {
  const f = fixture({ providerVerified: false })
  const before = identityState(f)
  const response = await f.begin()
  assert.equal(response.status, 401)
  assertRejected(f, response, before)
  assert.deepEqual(f.policyCalls, [])
})

test("SAML real SDK newSession after-hook observes organization JIT membership", async () => {
  const f = fixture({ jit: true })
  await assertSignedIn(f, await f.signIn(), email, true)
  assert.deepEqual(f.lifecycle, ["provision", "after-session-with-member"])
  assert.equal(f.data.member.length, 1)
  assert.equal(f.data.member[0]?.userId, f.data.user[0]?.id)
})
