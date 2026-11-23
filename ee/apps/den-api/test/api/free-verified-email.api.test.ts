import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { eq } from "@openwork-ee/den-db/drizzle"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { AuthUserTable, FeatureRolloutTable, InferenceFreeUsageTable } from "@openwork-ee/den-db/schema"
import { MEMBER_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH } from "@openwork/free-auto"
import { freeUsageAmount } from "@openwork/free-auto/accounting"
import { deriveReleaseSecret } from "@openwork/free-auto/node"
import { INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"
import { DesktopFreeSession } from "../../../../../apps/server/src/free-auto/desktop-session.js"
import { fixtureDesktopSigner } from "../../../gateway/test/fixtures/desktop-signer.js"
import { bootDen, field, summary, text, type Session } from "./harness.js"

test("one verified email opens two organizations with one founder allowance", async t => {
  const den = await bootDen({ env: { INFERENCE_FREE_ENABLED: "true", DEN_REQUIRE_EMAIL_VERIFICATION: "true" } })
  t.after(() => den.close())
  const { db } = await import("../../src/db.js")
  const { getLastDevEmail, listDevEmails } = await import("../../src/utils/email/send-email.js")
  async function verifyFromInbox(email: string) {
    const mail = getLastDevEmail("verification")
    assert.equal(mail?.to, email)
    const otp = mail?.html.match(/\b(\d{6})\b/)?.[1]
    assert.ok(otp)
    const verified = await den.request(null, "POST", "/api/auth/email-otp/verify-email", { body: { email, otp } })
    assert.equal(verified.status, 200, summary(verified))
  }
  async function signUpVerified(name: string): Promise<Session> {
    const email = `${name}+${den.stamp}@example.test`
    const signup = await den.request(null, "POST", "/api/auth/sign-up/email", { body: { email, name, password: den.password } })
    assert.equal(signup.status, 200, summary(signup))
    await verifyFromInbox(email)
    const signedIn = await den.signIn(email)
    assert.equal(signedIn.status, 200, summary(signedIn))
    assert.equal(field(signedIn.body, "user", "emailVerified"), true)
    return { name, email, userId: text(field(signedIn.body, "user", "id"), "user id"),
      token: text(field(signedIn.body, "token"), "session token"), cookie: text(signedIn.headers.get("set-cookie")?.split(";")[0], "session cookie") }
  }
  const owner = await signUpVerified("founder")
  const first = await den.createOrg(owner, "First workspace")
  const second = await den.request(owner.token, "POST", "/api/auth/organization/create", {
    headers: { cookie: owner.cookie }, body: { name: "Second workspace", slug: "second-workspace" },
  })
  assert.equal(second.status, 200, summary(second))
  const secondId = text(field(second.body, "id"), "second organization")
  assert.notEqual(first.orgId, secondId)
  const teammate = await den.join(owner, first.orgId, await signUpVerified("teammate"))
  async function credential(user: Session, orgId: string) {
    const result = await den.request(user.token, "POST", "/v1/inference/free/credential", { orgId })
    assert.equal(result.status, 200, summary(result))
    return text(field(result.body, "credential", "apiKey"), "model credential")
  }
  const firstKey = await credential(owner, first.orgId)
  const secondKey = await credential(owner, secondId)
  const teammateKey = await credential(teammate, first.orgId)
  // The existing model key must observe a subsequent change in the account's verification state.
  await db.update(AuthUserTable).set({ emailVerified: false }).where(eq(AuthUserTable.id, normalizeDenTypeId("user", teammate.userId)))
  await db.insert(FeatureRolloutTable).values({ feature_key: "freeAutoCrossOrgBudgets", enabled: true })

  const { readAutoConfig } = await import("../../../gateway/src/free/shared/config.js")
  const { createFreeMemberHandler } = await import("../../../gateway/src/free/member/handler.js")
  const { createFreeAllowanceStore } = await import("../../../gateway/src/free/shared/allowance.js")
  const { maximumCompletionCost } = await import("../../../gateway/src/free/member/shared-budget.js")
  const { findMemberFreePrincipal, readFreePrincipalDefaultPinned } = await import("../../../gateway/src/free/shared/principal.js")
  const { registerAnonymousInferenceRoutes } = await import("../../../gateway/src/free/guest/routes.js")
  const { inferenceAuth } = await import("../../../gateway/src/middleware/inference-auth.js")
  const { findActiveInferenceKey } = await import("../../../gateway/src/keys.js")
  const { client } = await import("../../../gateway/src/db.js")
  t.after(async () => { if ("end" in client) await client.end() })
  const config = readAutoConfig({ INFERENCE_FREE_ENABLED: "true", ANONYMOUS_INFERENCE_ENABLED: "true",
    INFERENCE_FREE_OPENAI_API_KEY: "fixture", ANONYMOUS_ACCOUNTING_IDENTITY_KEY: "fixture-accounting-identity-key-000000",
    ANONYMOUS_TOKEN_SECRET: "fixture-token-secret-00000000000000000", DESKTOP_FREE_RELEASE_KEY: "fixture-release-key-000000000000000000" })
  const completionCost = freeUsageAmount(config, 100, 10)
  const reservation = maximumCompletionCost(config, 1)
  assert.ok(reservation)
  config.orgWeeklyAmount = reservation + completionCost
  let providerCalls = 0
  const common = { config, clientAddress: () => "203.0.113.40", requireDesktop: async () => true, fetch: async () => {
    providerCalls += 1
    return Response.json({ id: `fixture-${providerCalls}`, model: config.upstreamModel, choices: [{ index: 0, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } })
  } }
  const gateway = new Hono()
  registerAnonymousInferenceRoutes(gateway, { ...common, store: createFreeAllowanceStore(config, "anonymous", db) })
  const handle = createFreeMemberHandler({ ...common, store: createFreeAllowanceStore(config, "member", db),
    findMember: key => findMemberFreePrincipal(key, db), defaultPinned: principal => readFreePrincipalDefaultPinned(principal, db) })
  gateway.on(["GET", "POST"], [MEMBER_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH], inferenceAuth({ findActiveInferenceKey }), c => {
    const auth = c.get("inference")
    assert.equal(auth.kind, "models")
    return handle(c, auth.key)
  })
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => gateway.request(url, init))
  const desktop = new DesktopFreeSession(await fixtureDesktopSigner(t, version => deriveReleaseSecret(config.releaseKey, version)), "https://gateway.test")
  const body = new TextEncoder().encode(JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hello" }] }))
  async function send(key: string) {
    const headers = await desktop.headers(`Bearer ${key}`, MEMBER_FREE_CHAT_PATH, "POST", body, new AbortController().signal)
    const result = await gateway.request(MEMBER_FREE_CHAT_PATH, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body })
    return { status: result.status, body: await result.json() }
  }
  const refused = await send(teammateKey)
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, "email_verification_required")
  assert.equal(providerCalls, 0)
  assert.deepEqual(await db.select().from(InferenceFreeUsageTable), [])
  const resend = await den.request(teammate.token, "POST", "/api/auth/email-otp/send-verification-otp", {
    body: { email: teammate.email, type: "email-verification" },
  })
  assert.equal(resend.status, 200, summary(resend))
  await verifyFromInbox(teammate.email)
  const headers = await desktop.headers(`Bearer ${teammateKey}`, MEMBER_FREE_STATUS_PATH, "GET", new Uint8Array(), new AbortController().signal)
  const ready = await gateway.request(MEMBER_FREE_STATUS_PATH, { headers })
  assert.equal((await ready.json()).state, "ready")
  for (const key of [firstKey, secondKey]) {
    const result = await send(key)
    assert.equal(result.status, 200, JSON.stringify(result.body))
  }
  const charges = await db.select({ org: InferenceFreeUsageTable.organization_id, amount: InferenceFreeUsageTable.amount,
    estimated: InferenceFreeUsageTable.estimated }).from(InferenceFreeUsageTable)
  assert.deepEqual(charges.sort((a, b) => a.org.localeCompare(b.org)), [first.orgId, secondId].sort().map(org => ({ org, amount: completionCost, estimated: false })))
  const exhausted = await send(firstKey)
  assert.equal(exhausted.body.error.code, "free_founder_budget_exhausted")
  assert.equal(providerCalls, 2)
  assert.equal(listDevEmails("verification").filter(email => email.to === owner.email).length, 1)
})
