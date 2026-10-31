import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const realFetch = globalThis.fetch
let upstreamKeys = 0
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === "https://openrouter.ai/api/v1/keys" && init?.method === "POST") {
    upstreamKeys++
    return Response.json({ key: "fixture-private-org-model-key", data: { hash: "fixture-private-org-model-key-hash" } })
  }
  return realFetch(input, init)
}
const den = await bootDen({ env: {
  INFERENCE_FREE_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_fixture_only",
  STRIPE_INFERENCE_PRICE_ID: "price_fixture_only", OPENROUTER_MANAGEMENT_API_KEY: "fixture_management_key",
  DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "fixture-models-resume-token-1234567890",
} })
after(async () => { globalThis.fetch = realFetch; await den.close() })

test("only a live signed-in member gets their own recovery options and current purchase permissions", async () => {
  const path = "/v1/workbot/model-recovery"
  const { orgId, owner } = await den.createOrg(await den.signUp("Workspace Owner"), "Recovery workspace")
  const other = await den.createOrg(await den.signUp("Other Workspace Owner"), "Other workspace")
  const member = await den.newMember(owner, orgId, "Workspace Member")
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const memberToken = await den.mintMcpToken(member, orgId)
  assert.equal((await den.request(null, "GET", path)).status, 401)
  const ownerOptions = await den.request(ownerToken, "GET", path, { orgId: other.orgId })
  assert.equal(ownerOptions.status, 200, summary(ownerOptions))
  assert.equal(ownerOptions.headers.get("cache-control"), "no-store")
  assert.deepEqual(ownerOptions.body, { canUpgrade: false, purchaseEligible: true, managedLuna: true, hasModelsSubscription: false, paidContinuation: "after_upgrade", upgradeBlockedReason: null, canManageModels: true, canManageBilling: true, freeExhausted: false, freeResetsAt: null })
  // Arrange exhausted accounting in the disposable database; every observation
  // still crosses the authenticated API as the member who owns the allowance.
  const [{ db }, { eq }, { InferenceFreeUsageBucketTable, InferenceOrgUpstreamProviderKeyTable, OrganizationTable, OrgSubscriptionTable }, { createDenTypeId, normalizeDenTypeId }, { freeInferenceDigest }, { freeInferenceWindow, INFERENCE_USAGE_CONVERSION_FACTOR }] = await Promise.all([
    import("../../src/db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/utils/typeid"), import("@openwork-ee/utils/free-inference-digest"), import("@openwork/types/den/inference"),
  ])
  const window = freeInferenceWindow()
  await db.insert(InferenceFreeUsageBucketTable).values({ id: freeInferenceDigest("test-bucket", owner.userId), identity_hash: freeInferenceDigest("member", owner.userId),
    window_start_at: window.start, window_end_at: window.end, limit_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR, used_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR })
  const exhausted = await den.request(ownerToken, "GET", path)
  assert.equal(field(exhausted.body, "purchaseEligible"), true)
  assert.equal(field(exhausted.body, "canUpgrade"), true, "completed checkout activates the managed paid Luna route")
  assert.equal(field(exhausted.body, "freeExhausted"), true)
  assert.equal(field(exhausted.body, "freeResetsAt"), window.end.toISOString())
  await db.insert(InferenceFreeUsageBucketTable).values({ id: freeInferenceDigest("test-bucket", member.userId), identity_hash: freeInferenceDigest("member", member.userId),
    window_start_at: window.start, window_end_at: window.end, limit_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR, used_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR })
  const memberOptions = await den.request(memberToken, "GET", path)
  assert.equal(memberOptions.status, 200, summary(memberOptions))
  assert.deepEqual(memberOptions.body, { canUpgrade: false, purchaseEligible: false, managedLuna: true, hasModelsSubscription: false, paidContinuation: "unavailable", upgradeBlockedReason: "paid_workbot_route_unavailable", canManageModels: false, canManageBilling: false, freeExhausted: true, freeResetsAt: window.end.toISOString() })
  const organizationId = normalizeDenTypeId("organization", orgId)
  await db.insert(OrgSubscriptionTable).values({ id: createDenTypeId("orgSubscription"), organization_id: organizationId, type: "inference", status: "past_due", stripe_customer_id: "cus_recovery_fixture", stripe_subscription_id: "sub_recovery_fixture" })
  const subscribed = await den.request(ownerToken, "GET", path)
  assert.equal(field(subscribed.body, "hasModelsSubscription"), true)
  assert.equal(field(subscribed.body, "purchaseEligible"), false, "an existing past-due subscription gets no new-subscription offer")
  assert.equal(field(subscribed.body, "freeExhausted"), true, "paid organizations retain the member’s exhausted weekly Auto allowance")
  await db.update(OrgSubscriptionTable).set({ status: "active" }).where(eq(OrgSubscriptionTable.organization_id, organizationId))
  const activeSubscriber = await den.request(ownerToken, "GET", path)
  assert.equal(field(activeSubscriber.body, "purchaseEligible"), false)
  assert.equal(field(activeSubscriber.body, "freeExhausted"), true, "an active subscription does not refill Auto")
  // Use the activation function called by completed Models checkout. Only OpenRouter's external key API is synthetic.
  const { setInferenceEnabled } = await import("../../src/inference.js")
  const { WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID } = await import("@openwork/types/den/workbot-settings")
  const freeRun = await den.request(memberToken, "POST", "/v1/workbot/run-token", { body: { model: WORKBOT_FREE_LUNA_ID } })
  assert.equal(freeRun.status, 200, summary(freeRun))
  assert.equal(field(freeRun.body, "modelAccess", "protocol"), "openai-responses")
  const memberKey = field(freeRun.body, "modelAccess", "apiKey")
  assert.equal(field((await den.request(memberToken, "GET", "/v1/workbot/session")).body, "model"), WORKBOT_FREE_LUNA_ID)
  assert.equal((await den.as(member, orgId)("POST", "/v1/billing/stripe/checkout/sync", { sessionId: "cs_fixture_denied" })).status, 403)
  await setInferenceEnabled({ organizationId, enabled: true })
  assert.equal(upstreamKeys, 1)
  const paidOptions = await den.request(memberToken, "GET", path)
  assert.equal(field(paidOptions.body, "paidContinuation"), "authorized", "members can use paid Models even when they cannot purchase")
  assert.equal(field(paidOptions.body, "canUpgrade"), false)
  assert.equal(field(paidOptions.body, "freeExhausted"), true, "checkout never refills Auto")
  const paidSession = await den.request(memberToken, "GET", "/v1/workbot/session")
  assert.equal(field(paidSession.body, "model"), WORKBOT_PAID_LUNA_ID)
  const turn = { sessionId: "hs_models_resume_fixture", messageId: "wb_paid_message" }
  const paidRun = await den.request(memberToken, "POST", "/v1/workbot/run-token", { body: { ...turn, model: WORKBOT_PAID_LUNA_ID } })
  assert.equal(paidRun.status, 200, summary(paidRun))
  assert.equal(field(paidRun.body, "modelAccess", "apiKey"), memberKey, "paid Luna uses the same member Models entitlement")
  assert.equal(field(paidRun.body, "modelAccess", "protocol"), "openai")
  assert.equal(field(paidRun.body, "modelAccess", "model"), "openai/gpt-6-luna")
  const exchange = () => den.request(null, "POST", "/v1/headless/resume-token", { headers: { authorization: "Bearer fixture-models-resume-token-1234567890" },
    body: { ...turn, grant: field(paidRun.body, "resumeGrant"), model: WORKBOT_PAID_LUNA_ID, modelAccessRequired: true } })
  const resumed = await exchange()
  assert.equal(resumed.status, 200, summary(resumed))
  assert.equal(field(resumed.body, "modelAccess", "apiKey"), memberKey)
  assert.equal((await exchange()).status, 200, "an admitted paid turn can resume without rollout state")
  const retainedAuto = await den.request(memberToken, "POST", "/v1/workbot/run-token", { body: { model: WORKBOT_FREE_LUNA_ID } })
  assert.equal(field(retainedAuto.body, "modelAccess", "protocol"), "openai-responses", "an original Auto retry never silently changes to paid usage")
  const readiness = await den.as(member, orgId)("GET", "/v1/org/workbot-readiness")
  assert.deepEqual(readiness.body, { gatewayRequired: false, hasGatewayProvider: false })
  const settings = await den.as(owner, orgId)("GET", "/v1/org/workbot-settings")
  assert.equal(field(settings.body, "defaultModel"), WORKBOT_PAID_LUNA_ID)
  assert.equal(field(settings.body, "defaultReadiness"), "available")
  const savedDefault = await den.as(owner, orgId)("PUT", "/v1/org/workbot-settings", { model: WORKBOT_PAID_LUNA_ID })
  assert.equal(savedDefault.status, 200, summary(savedDefault))
  assert.equal(field(savedDefault.body, "model"), null, "the managed starter never becomes a shared custom default")
  for (const response of [paidOptions, paidSession, readiness, settings, savedDefault]) {
    assert.equal(response.text.includes(String(memberKey)), false)
    assert.equal(response.text.includes("fixture-private-org-model-key"), false)
  }
  await db.update(InferenceOrgUpstreamProviderKeyTable).set({ status: "revoked" }).where(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId))
  const waiting = await den.request(ownerToken, "GET", path)
  assert.equal(field(waiting.body, "paidContinuation"), "unavailable")
  assert.equal(field(waiting.body, "canUpgrade"), false, "a paid setup failure never prompts a second purchase")
  const notReady = await den.request(ownerToken, "POST", "/v1/workbot/run-token", { body: { model: WORKBOT_PAID_LUNA_ID } })
  assert.equal(notReady.status, 403)
  assert.equal(field(notReady.body, "reason"), "managed_models_setup_required")
  await db.update(InferenceOrgUpstreamProviderKeyTable).set({ status: "active" }).where(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId))
  await db.update(OrganizationTable).set({ metadata: { inference: { enabled: true, tier: "tier1" }, workbot: { model: "gateway/legacy" } } }).where(eq(OrganizationTable.id, organizationId))
  const invalid = await den.request(memberToken, "GET", path)
  assert.equal(field(invalid.body, "managedLuna"), false)
  assert.equal(field(invalid.body, "paidContinuation"), "unavailable", "an invalid saved custom model is not silently migrated to managed Luna")
  assert.equal(field((await den.request(memberToken, "GET", "/v1/workbot/session")).body, "model"), "gateway/legacy")
  await db.delete(OrgSubscriptionTable).where(eq(OrgSubscriptionTable.organization_id, organizationId))
  await db.update(OrganizationTable).set({ metadata: { dpaSigned: true } }).where(eq(OrganizationTable.id, organizationId))
  const policyBlocked = await den.request(ownerToken, "GET", path)
  assert.equal(field(policyBlocked.body, "canUpgrade"), false)
  assert.equal(field(policyBlocked.body, "freeResetsAt"), null, "unavailable managed access must not claim a free reset will restore it")
  const otherToken = await den.mintMcpToken(other.owner, other.orgId)
  const otherRecovery = await den.request(otherToken, "GET", path, { orgId })
  assert.equal(otherRecovery.status, 200, summary(otherRecovery))
  assert.equal(field(otherRecovery.body, "freeExhausted"), false, "a browser-selected organization cannot expose another workspace’s allowance")
  assert.equal(field(otherRecovery.body, "hasModelsSubscription"), false)
  assert.equal(field((await den.request(ownerToken, "GET", "/v1/workbot/session")).body, "usageRecovery"), true)
  const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${member.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  assert.equal((await den.request(memberToken, "GET", path)).status, 401)
  assert.equal((await exchange()).status, 403, "removing membership revokes paid resume access")
  for (const model of [WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID]) {
    assert.equal((await den.request(ownerToken, "POST", "/v1/workbot/run-token", { body: { model } })).status, 403, "GA never bypasses workspace policy or paid entitlement")
  }
})

test("GA recovery reaches every member without granting management or purchase permissions", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("GA Owner"), "GA workspace")
  const member = await den.newMember(owner, orgId, "GA Member")
  for (const person of [owner, member]) {
    const options = await den.request(await den.mintMcpToken(person, orgId), "GET", "/v1/workbot/model-recovery")
    assert.equal(options.status, 200, summary(options))
    assert.equal(field(options.body, "managedLuna"), true)
    assert.equal(field(options.body, "canManageModels"), person === owner)
    assert.equal(field(options.body, "purchaseEligible"), person === owner)
    const readiness = await den.as(person, orgId)("GET", "/v1/org/workbot-readiness")
    assert.deepEqual(readiness.body, { gatewayRequired: false, hasGatewayProvider: false })
  }
  assert.equal((await den.as(member, orgId)("PUT", "/v1/org/workbot-settings", { model: null })).status, 403)
  assert.equal((await den.as(member, orgId)("GET", "/v1/org/workbot-settings")).status, 403)
})

test("GA included models start Workbot without a provider and fall back only when not entitled", async () => {
  const path = "/v1/workbot/model-recovery"
  const { WORKBOT_DEFAULT_MODEL_ID, WORKBOT_FREE_LUNA_ID } = await import("@openwork/types/den/workbot-settings")
  const { orgId, owner } = await den.createOrg(await den.signUp("Included Owner"), "Included models workspace")
  const member = await den.newMember(owner, orgId, "Included Member")
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const memberToken = await den.mintMcpToken(member, orgId)
  const run = (token: string, body: Record<string, unknown> = {}) => den.request(token, "POST", "/v1/workbot/run-token", { body })
  const session = async (token: string) => (await den.request(token, "GET", "/v1/workbot/session")).body

  // Fresh organizations need neither rollout state nor a custom Gateway provider.
  assert.equal(field(await session(memberToken), "model"), WORKBOT_FREE_LUNA_ID, "no provider needed: the member's free Auto is the default")
  assert.equal(field(await session(memberToken), "usageRecovery"), true, "the limit card is available with included models")
  const firstTurn = await run(memberToken)
  assert.equal(firstTurn.status, 200, summary(firstTurn))
  assert.equal(field(firstTurn.body, "modelAccess", "protocol"), "openai-responses", "a turn without a pinned model uses included Auto")
  assert.equal((await run(memberToken, { model: WORKBOT_FREE_LUNA_ID })).status, 200)
  assert.deepEqual((await den.as(member, orgId)("GET", "/v1/org/workbot-readiness")).body, { gatewayRequired: false, hasGatewayProvider: false })
  const ownerOptions = await den.request(ownerToken, "GET", path)
  assert.equal(ownerOptions.status, 200, summary(ownerOptions))
  assert.equal(field(ownerOptions.body, "purchaseEligible"), true, "purchase still requires configured billing and owner permissions")
  assert.equal(field(ownerOptions.body, "paidContinuation"), "after_upgrade")
  assert.equal(field(ownerOptions.body, "canManageModels"), true)

  // Exhausted: the member's own allowance, reported with its reset and permission-aware recovery.
  const [{ db }, { eq }, { InferenceFreeUsageBucketTable, OrganizationTable }, { normalizeDenTypeId }, { freeInferenceDigest }, { freeInferenceWindow, INFERENCE_USAGE_CONVERSION_FACTOR }] = await Promise.all([
    import("../../src/db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/utils/typeid"), import("@openwork-ee/utils/free-inference-digest"), import("@openwork/types/den/inference"),
  ])
  const window = freeInferenceWindow()
  await db.insert(InferenceFreeUsageBucketTable).values({ id: freeInferenceDigest("included-bucket", owner.userId), identity_hash: freeInferenceDigest("member", owner.userId),
    window_start_at: window.start, window_end_at: window.end, limit_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR, used_amount: 5 * INFERENCE_USAGE_CONVERSION_FACTOR })
  const exhausted = await den.request(ownerToken, "GET", path)
  assert.equal(field(exhausted.body, "freeExhausted"), true)
  assert.equal(field(exhausted.body, "freeResetsAt"), window.end.toISOString())
  assert.equal(field(exhausted.body, "canUpgrade"), true)
  assert.equal(field(await session(ownerToken), "model"), WORKBOT_FREE_LUNA_ID, "an exhausted allowance stays on Auto so the turn reports the limit, not a missing provider")

  // Not entitled (workspace policy blocks managed models): Workbot keeps the workspace Gateway instead of a dead route.
  await db.update(OrganizationTable).set({ metadata: { dpaSigned: true } }).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))
  assert.equal(field(await session(memberToken), "model"), WORKBOT_DEFAULT_MODEL_ID)
  assert.equal(field((await den.as(member, orgId)("GET", "/v1/org/workbot-readiness")).body, "gatewayRequired"), true)
  const blocked = await run(memberToken)
  assert.equal(blocked.status, 403)
  assert.notEqual(field(blocked.body, "reason"), "model_access_unavailable", "the refusal names the Gateway state, not the blocked included route")
  await db.update(OrganizationTable).set({ metadata: {} }).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))

  assert.equal(field(await session(memberToken), "model"), WORKBOT_FREE_LUNA_ID, "restoring policy restores included access without rollout state")
  assert.equal((await run(memberToken, { model: WORKBOT_FREE_LUNA_ID })).status, 200)
})
