import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { AnonymousInferenceUsageTable as GuestUsage } from "@openwork-ee/den-db/schema"
import { bootDen, field } from "./harness.js"

const secret = randomBytes(32)
const den = await bootDen({ env: { OPENAI_SAFETY_READ_KEY: "safety-read-fixture", OPENAI_SAFETY_WEBHOOK_SECRET: "whsec_" + secret.toString("base64") } })
const { db } = await import("../../src/db.js")
const { setFeatureRollout } = await import("@openwork-ee/den-db/organization-features")
const { createFreeAllowanceStore } = await import("../../../gateway/src/free/shared/allowance.js")
const { readAutoConfig } = await import("../../../gateway/src/free/shared/config.js")
after(async () => {
  const { client } = await import("../../../gateway/src/db.js")
  if ("end" in client) await client.end()
  await den.close()
})
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const member = await den.signUp("Member")
const principal = { kind: "member" as const, id: normalizeDenTypeId("user", member.userId), memberId: createDenTypeId("member"),
  organizationId: createDenTypeId("organization"), inferenceKeyId: createDenTypeId("inferenceKey") }
const store = createFreeAllowanceStore(readAutoConfig({}), "member", db)
const identifier = freeInferenceDigest("member", principal.id)
const path = "/v1/admin/free-auto/safety-cases"
const issued = Math.floor(Date.now() / 1000)
function delivery(type: string, id: string, timestamp = issued, tamper = false) {
  const raw = JSON.stringify({ id: "evt_fixture", object: "event", type, data: { id, entity_identifier: "untrusted" } })
  const signature = createHmac("sha256", secret).update(`delivery.${timestamp}.${raw}`).digest("base64")
  return den.request(null, "POST", "/v1/webhooks/openai/safety", { rawBody: tamper ? raw + " " : raw, headers: {
    "content-type": "application/json", "webhook-id": "delivery", "webhook-timestamp": String(timestamp), "webhook-signature": "v1," + signature,
  } })
}
const decide = (id: string, decision: string) => den.request(admin.token, "POST", path + "/" + id + "/decision", { body: { decision } })

test("signed warnings, reviewed blocks, appeals and provider deactivations reach the gateway", async t => {
  let failRead = false
  const fixture = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.redirect, "error")
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer safety-read-fixture")
    assert.ok(url.startsWith("https://api.openai.com/v1/safety/cases/"))
    if (failRead) return new Response(null, { status: 503 })
    const id = url.split("/").at(-1)
    return Response.json({ object: "safety.case", id, created_at: issued, reason: "cyber_abuse", entity_identifier: identifier,
      notice: { type: id === "C-deactivation" ? "deactivation" : "warning" } })
  })
  assert.equal((await delivery("safety.warning_issued", "C-warning", issued, true)).status, 401)
  assert.equal((await delivery("safety.warning_issued", "C-warning", issued - 3600)).status, 401)
  assert.equal(fixture.mock.callCount(), 0)
  assert.equal((await den.request(null, "GET", path)).status, 401)
  assert.equal((await den.request(member.token, "POST", path + "/import", { body: { caseId: "C-warning" } })).status, 403)
  await setFeatureRollout(db, { key: "freeAutoSafetyCases", enabled: true, defaultEnabled: false })
  assert.equal(await store.safetyPaused(principal), false)
  failRead = true
  assert.equal((await delivery("safety.warning_issued", "C-warning")).status, 503)
  failRead = false
  assert.equal((await delivery("safety.warning_issued", "C-warning")).status, 204)
  const inspected = await den.request(admin.token, "GET", path + "/C-warning")
  assert.equal(inspected.status, 200)
  assert.equal(field(inspected.body, "identifier"), identifier)
  assert.equal(field(inspected.body, "userId"), member.userId)
  assert.equal(field(inspected.body, "state"), "review")
  assert.equal(await store.safetyPaused(principal), false)
  assert.equal((await den.request(member.token, "POST", path + "/C-warning/decision", { body: { decision: "confirmed_misuse" } })).status, 403)
  assert.equal((await decide("C-warning", "confirmed_misuse")).status, 200)
  assert.equal((await delivery("safety.warning_issued", "C-warning")).status, 204)
  assert.equal(await store.safetyPaused({ ...principal, organizationId: createDenTypeId("organization"), inferenceKeyId: createDenTypeId("inferenceKey") }), true)
  assert.equal((await delivery("safety.deactivation_issued", "C-warning")).status, 503)
  assert.equal((await decide("C-warning", "appeal_upheld")).status, 200)
  assert.equal((await decide("C-warning", "appeal_upheld")).status, 200)
  const review = await den.request(admin.token, "GET", path + "/C-warning")
  const history = field(review.body, "history")
  assert.ok(Array.isArray(history))
  assert.deepEqual(history.map(entry => field(entry, "decision")), ["confirmed_misuse", "appeal_upheld"])
  assert.equal(await store.safetyPaused(principal), false)
  assert.equal((await den.request(admin.token, "POST", path + "/import", { body: { caseId: "C-deactivation" } })).status, 200)
  assert.equal((await delivery("safety.deactivation_issued", "C-deactivation")).status, 204)
  assert.equal((await decide("C-deactivation", "appeal_upheld")).status, 409)
  for (const id of ["C-first", "C-second"]) assert.equal((await delivery("safety.warning_issued", id)).status, 204)
  const first = await den.request(admin.token, "GET", path + "?limit=1")
  assert.equal(first.status, 200)
  const cursor = field(first.body, "nextCursor")
  assert.equal(typeof cursor, "string")
  const next = await den.request(admin.token, "GET", path + "?limit=1&cursor=" + cursor)
  assert.equal(next.status, 200)
  const pages = [first, next].flatMap(page => {
    const items = field(page.body, "items")
    assert.ok(Array.isArray(items))
    return items.map(item => field(item, "caseId"))
  })
  assert.deepEqual(pages.sort(), ["C-first", "C-second"])
  assert.equal((await delivery("safety.warning_issued", "C-warning")).status, 204)
  assert.equal(await store.safetyPaused(principal), true)
  assert.equal(await store.safetyPaused({ ...principal, id: createDenTypeId("user") }), false)
  await setFeatureRollout(db, { key: "freeAutoSafetyCases", enabled: false, defaultEnabled: false })
  assert.equal(await store.safetyPaused(principal), false)
})

test("an organization notice can be investigated from a recorded request without assigning a guest to a person", async () => {
  const requestId = randomBytes(16).toString("hex")
  const start = () => den.request(admin.token, "POST", path + "/from-request", { body: { requestId } })
  assert.equal((await start()).status, 404)
  await db.insert(GuestUsage).values({ request_id: requestId, principal_hash: "a".repeat(64), model_id: "fixture", amount: 1 })
  const created = await start()
  assert.equal(created.status, 200)
  const id = field(created.body, "caseId")
  assert.equal(id, "local-" + requestId)
  const detail = await den.request(admin.token, "GET", path + "/" + id)
  assert.equal(field(detail.body, "subject"), "guest")
  assert.equal(field(detail.body, "userId"), null)
  assert.equal((await start()).status, 200)
  assert.equal(field(detail.body, "state"), "review")
})

test("verified provider account holds cover funded routes across memberships and replacement keys", async () => {
  const { Hono } = await import("hono")
  const { registerProxyRoutes } = await import("../../../gateway/src/proxy.js")
  const { fundedModelGuard } = await import("../../../gateway/src/funded-model-access.js")
  const { createInferenceBearerKey, inferenceBearerKeyLookupDigest } = await import("@openwork-ee/utils/inference-bearer-key")
  const { InferenceKeyTable, SandboxOrganizationTable } = await import("@openwork-ee/den-db/schema")
  const { assertFundedUserAllowed } = await import("../../src/openai-safety/account-suspensions.js")
  const first = await den.createOrg(member, "First workspace")
  const other = await den.createOrg(admin, "Team workspace")
  const joined = await den.join(admin, other.orgId, member)
  const api = (id: string) => "/v1/admin/users/" + id + "/funded-model-suspensions"
  const apply = (token: string, id: string, reference: string) => den.request(token, "POST", api(id), { body: { reference, verified: "provider_requested_account_suspension" } })
  const release = (reference: string) => den.request(admin.token, "POST", api(member.userId) + "/release", { body: {
    reference, releaseReference: "R-fixture", verified: "provider_authorized_reinstatement",
  } })
  const keyFor = async (orgId: string, memberId: string) => {
    const key = createInferenceBearerKey()
    await db.insert(InferenceKeyTable).values({ id: createDenTypeId("inferenceKey"), organization_id: normalizeDenTypeId("organization", orgId),
      org_membership_id: normalizeDenTypeId("member", memberId), key_hash: await inferenceBearerKeyLookupDigest(key) })
    return key.value
  }
  const gateway = new Hono()
  registerProxyRoutes(gateway)
  const send = (key: string, path: string, model: string) => gateway.request("/api/v1/" + path, { method: "POST", headers: {
    authorization: "Bearer " + key, "content-type": "application/json",
  }, body: JSON.stringify({ model, messages: [{ role: "user", content: "fixture" }] }) })
  const initialKey = await keyFor(first.orgId, first.owner.memberId)
  const memberScope = { organizationId: other.orgId, orgMembershipId: joined.memberId }
  const guard = fundedModelGuard(db)
  assert.equal((await apply(member.token, member.userId, "C-request")).status, 403)
  const pending = await apply(admin.token, member.userId, "C-request")
  assert.equal(pending.status, 200)
  assert.equal(field(pending.body, "enforcementEnabled"), false)
  assert.equal(await guard(memberScope, { kind: "managed" }), null)
  await setFeatureRollout(db, { key: "fundedModelAccountSuspensions", enabled: true, defaultEnabled: false })
  assert.equal((await apply(admin.token, admin.userId, "C-request")).status, 409)
  assert.equal((await apply(admin.token, member.userId, "C-request")).status, 200)
  assert.equal((await apply(admin.token, member.userId, "C-second-hold")).status, 200)
  for (const [key, endpoint, model] of [[initialKey, "chat/completions", "openwork/auto"], [await keyFor(other.orgId, joined.memberId), "responses", "openwork/auto"], [await keyFor(first.orgId, first.owner.memberId), "chat/completions", "paid-model"]]) {
    const denied = await send(key, endpoint, model)
    assert.equal(denied.status, 403)
    assert.equal(field(await denied.json(), "error", "code"), "funded_model_account_suspended")
  }
  assert.equal(await guard({ ...memberScope, orgMembershipId: other.owner.memberId }, { kind: "managed" }), null)
  assert.equal((await guard({ ...memberScope, orgMembershipId: null }, { kind: "managed" }))?.status, 503)
  await assert.rejects(assertFundedUserAllowed(member.userId), /funded_model_account_suspended/)
  assert.equal(await guard(memberScope, { kind: "sandbox" }), null)
  const set = createDenTypeId("gatewayCredentialSet")
  await db.insert(SandboxOrganizationTable).values({ id: createDenTypeId("sandboxOrganization"), organizationId: normalizeDenTypeId("organization", other.orgId),
    joinToken: "fixture", memberLimit: 8, expiresAt: new Date(Date.now() + 86400000), createdByUserId: normalizeDenTypeId("user", admin.userId), sponsoredSetId: set })
  assert.equal((await guard(memberScope, { kind: "sandbox", credentialSetId: set }))?.status, 403)
  assert.equal(await guard(memberScope, { kind: "sandbox", credentialSetId: createDenTypeId("gatewayCredentialSet") }), null)
  assert.equal((await release("C-request")).status, 200)
  assert.equal((await apply(admin.token, member.userId, "C-request")).status, 409)
  assert.equal((await guard(memberScope, { kind: "managed" }))?.status, 403)
  assert.equal((await release("C-second-hold")).status, 200)
  assert.equal(await guard(memberScope, { kind: "managed" }), null)
  const status = await den.request(admin.token, "GET", api(member.userId))
  assert.equal(field(status.body, "suspended"), false)
  assert.equal(field(status.body, "enforcementEnabled"), true)
})
