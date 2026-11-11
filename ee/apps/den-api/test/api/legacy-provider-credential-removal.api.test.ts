import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { eq } from "@openwork-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderMemberCredentialTable, LlmProviderModelTable, LlmProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const feature = "legacyProviderCredentialRemoval"
const canary = "synthetic-organization-credential-task-415"

async function world(label: string, enabled = true) {
  const org = await den.createOrg(await den.signUp(`Credential Owner ${label}`), `Credential fixture ${label}`)
  if (enabled) assert.equal((await den.setFeature(org.orgId, feature, true)).status, 200)
  const member = await den.newMember(org.owner, org.orgId, `Credential Member ${label}`)
  return { ...org, member }
}

async function createProvider(owner: Member, orgId: string, credentialMode: "shared" | "per_member" = "shared") {
  const response = await den.as(owner, orgId)("POST", "/v1/llm-providers", {
    name: "Shared custom provider", source: "custom", credentialMode, apiKey: canary, allMembers: true,
    customConfig: { id: "fixture-provider", name: "Shared custom provider", npm: "@ai-sdk/openai-compatible", env: ["FIXTURE_TEAM_API_KEY"],
      api: "https://inference.example.invalid/v1", models: [{ id: "fixture-model", name: "Fixture model", limit: { context: 32000 } }] },
  })
  assert.equal(response.status, 201, summary(response))
  return text(field(response.body, "llmProvider", "id"), "provider id")
}

async function snapshot(id: string) {
  const providerId = normalizeDenTypeId("llmProvider", id)
  const [provider] = await db.select().from(LlmProviderTable).where(eq(LlmProviderTable.id, providerId))
  assert.ok(provider)
  const { apiKey, updatedAt, ...configuration } = provider
  const bindings = await db.select().from(LlmProviderMemberCredentialTable).where(eq(LlmProviderMemberCredentialTable.llmProviderId, providerId))
  return {
    configuration, credentialPresent: Boolean(apiKey), credentialHash: apiKey === null ? null : createHash("sha256").update(apiKey).digest("hex"), updatedAt,
    models: await db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, providerId)),
    access: await db.select().from(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, providerId)),
    bindings: bindings.map(({ secret, ...binding }) => ({ ...binding, secretHash: createHash("sha256").update(secret).digest("hex") })),
  }
}

const endpoint = (id: string) => `/v1/llm-providers/${id}/credential`

test("an owner removes only the saved credential; identity, configuration, models and grants survive, and the action is audited without secrets", async () => {
  const w = await world("remove")
  const id = await createProvider(w.owner, w.orgId)
  const before = await snapshot(id)
  assert.equal(before.credentialPresent, true)
  const call = den.as(w.owner, w.orgId)
  const removed = await call("DELETE", endpoint(id))
  assert.equal(removed.status, 204, summary(removed))
  const after = await snapshot(id)
  assert.equal(after.credentialPresent, false)
  assert.deepEqual(after.configuration, before.configuration)
  assert.deepEqual(after.models, before.models)
  assert.deepEqual(after.access, before.access)
  assert.deepEqual(after.bindings, before.bindings)
  for (const path of [`/v1/llm-providers/${id}`, "/v1/llm-providers?scope=manageable"]) {
    const read = await call("GET", path)
    assert.equal(read.status, 200, summary(read))
    const provider = path.includes("?") ? list(field(read.body, "llmProviders")).find((row) => row.id === id) : field(read.body, "llmProvider")
    assert.equal(field(provider, "hasApiKey"), false)
    assert.deepEqual(field(provider, "configuredEnvKeys"), [])
    assert.equal(read.text.includes(canary), false)
  }
  const connected = await den.as(w.member, w.orgId)("GET", `/v1/llm-providers/${id}/connect`)
  assert.equal(connected.status, 200, summary(connected))
  assert.equal(field(connected.body, "llmProvider", "apiKey"), null)
  assert.equal(connected.text.includes(canary), false)

  const action = "llm_provider.credential.remove.succeeded"
  let operations: Record<string, unknown>[] = []
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    const response = await call("GET", `/v1/audit/operations?action=${action}&limit=50`)
    assert.equal(response.status, 200, summary(response))
    operations = list(field(response.body, "operations"))
    if (operations.length > 0) break
    await delay(100)
  }
  assert.equal(operations.length, 1)
  const events = await call("GET", `/v1/audit/operations/${String(operations[0]?.id)}/events?limit=50`)
  const event = list(field(events.body, "events")).find((entry) => entry.action === action)
  assert.ok(event)
  assert.equal(field(event, "outcome"), "succeeded")
  assert.equal(field(event, "actor", "memberId"), w.owner.memberId)
  assert.ok(list(field(event, "resources")).some((resource) => resource.id === id))
  assert.equal((await den.auditStorageText()).includes(canary), false)

  const missing = await snapshot(id)
  assert.equal((await call("DELETE", endpoint(id))).status, 204)
  assert.deepEqual(await snapshot(id), missing, "already missing is a no-op, including timestamp")
})

test("concurrent removal requests are idempotent and never rewrite configuration or related rows", async () => {
  const w = await world("concurrent")
  const id = await createProvider(w.owner, w.orgId)
  const before = await snapshot(id)
  const call = den.as(w.owner, w.orgId)
  const responses = await Promise.all([call("DELETE", endpoint(id)), call("DELETE", endpoint(id))])
  assert.deepEqual(responses.map((response) => response.status), [204, 204])
  const after = await snapshot(id)
  assert.equal(after.credentialPresent, false)
  assert.deepEqual(after.configuration, before.configuration)
  assert.deepEqual(after.models, before.models)
  assert.deepEqual(after.access, before.access)
  assert.deepEqual(after.bindings, before.bindings)
})

test("feature off, unauthorized members, cross-organization callers and unauthenticated requests cannot remove a credential", async () => {
  const w = await world("boundaries", false)
  const id = await createProvider(w.owner, w.orgId)
  const before = await snapshot(id)
  const off = await den.as(w.owner, w.orgId)("DELETE", endpoint(id))
  assert.equal(off.status, 404, summary(off))
  assert.equal(field(off.body, "error"), "feature_disabled")
  assert.deepEqual(await snapshot(id), before)
  assert.equal((await den.setFeature(w.orgId, feature, true)).status, 200)
  const denied = await den.as(w.member, w.orgId)("DELETE", endpoint(id))
  assert.equal(denied.status, 403, summary(denied))
  const other = await world("other")
  const foreign = await den.as(other.owner, other.orgId)("DELETE", endpoint(id))
  assert.equal(foreign.status, 404, summary(foreign))
  assert.notEqual((await den.request(null, "DELETE", endpoint(id), { orgId: w.orgId })).status, 204)
  assert.deepEqual(await snapshot(id), before)
})

test("a non-admin permission holder can remove another creator's credential using the existing update authorizer", async () => {
  const w = await world("permission")
  const id = await createProvider(w.owner, w.orgId)
  const owner = den.as(w.owner, w.orgId)
  const sets = await owner("GET", "/v1/permissions/sets")
  assert.equal(sets.status, 200, summary(sets))
  const memberSet = list(field(sets.body, "sets")).find((set) => set.kind === "member_default")
  assert.ok(memberSet)
  const grant = await owner("PUT", `/v1/permissions/sets/${String(memberSet.id)}/permissions`, { changes: [{ key: "llm_providers.update", status: "allow" }] })
  assert.equal(grant.status, 200, summary(grant))
  const removed = await den.as(w.member, w.orgId)("DELETE", endpoint(id))
  assert.equal(removed.status, 204, summary(removed))
  assert.equal((await snapshot(id)).credentialPresent, false)
})

test("a non-admin creator may remove their own credential but cannot remove another provider's; per-member and managed providers remain untouched", async () => {
  const w = await world("creator")
  const ownId = await createProvider(w.member, w.orgId)
  const ownedByAdmin = await createProvider(w.owner, w.orgId)
  assert.equal((await den.as(w.member, w.orgId)("DELETE", endpoint(ownId))).status, 204)
  assert.equal((await den.as(w.member, w.orgId)("DELETE", endpoint(ownedByAdmin))).status, 403)
  const perMember = await createProvider(w.owner, w.orgId, "per_member")
  const binding = await den.as(w.member, w.orgId)("PUT", `/v1/llm-providers/${perMember}/my-credential`, { apiKey: "synthetic-personal-credential" })
  assert.equal(binding.status, 200, summary(binding))
  const before = await snapshot(perMember)
  const refused = await den.as(w.owner, w.orgId)("DELETE", endpoint(perMember))
  assert.equal(refused.status, 409, summary(refused))
  assert.deepEqual(await snapshot(perMember), before)
  // An existing hosted row is never converted to a legacy shared provider by this action.
  await db.update(LlmProviderTable).set({ source: "openwork" }).where(eq(LlmProviderTable.id, normalizeDenTypeId("llmProvider", ownedByAdmin)))
  const managed = await snapshot(ownedByAdmin)
  assert.equal((await den.as(w.owner, w.orgId)("DELETE", endpoint(ownedByAdmin))).status, 409)
  assert.deepEqual(await snapshot(ownedByAdmin), managed)
})
