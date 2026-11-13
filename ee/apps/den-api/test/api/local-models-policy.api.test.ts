/**
 * Local models (Ollama, LM Studio) under AI Gateway › Who can use models (feature localModelsPolicy):
 * what an admin saves in the default desktop policy, and what each member's desktop is told.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })

const org = await den.createOrg(await den.signUp("Avery Owner"), "Acme")
const owner = den.as(org.owner, org.orgId)
const member = await den.newMember(org.owner, org.orgId, "Riley Member")
const memberCall = den.as(member, org.orgId)
const admin = await den.newMember(org.owner, org.orgId, "Drew Admin", "admin")

async function defaultPolicy() {
  const listed = await owner("GET", "/v1/desktop-policies")
  assert.equal(listed.status, 200, summary(listed))
  const policy = list(field(listed.body, "desktopPolicies")).find((entry) => entry.isDefault === true)
  assert.ok(policy, "the organization has a default desktop policy")
  return policy
}

/** Saved the way the Who can use models dialog saves it. */
async function save(values: Record<string, boolean>, call = owner) {
  const current = await defaultPolicy()
  const document = typeof current.policy === "object" && current.policy !== null ? current.policy : {}
  return call("PATCH", `/v1/desktop-policies/${text(current.id, "policy id")}`, {
    policyName: current.policyName, policy: { ...document, ...values }, priority: 0, isEnabled: true, memberIds: [], teamIds: [], roles: [],
  })
}

async function delivered(call = memberCall) {
  const config = await call("GET", "/v1/me/desktop-config")
  assert.equal(config.status, 200, summary(config))
  return { allowCustomProviders: field(config.body, "allowCustomProviders"), allowLocalModels: field(config.body, "allowLocalModels") }
}

test("the owner turns local models off for everyone, independently of personal keys; an admin sees but cannot change it", { timeout: 60_000 }, async () => {

  // A policy saved before the switch existed: local models inherit "Only models you provide".
  const current = await defaultPolicy()
  const legacy = await owner("PATCH", `/v1/desktop-policies/${text(current.id, "policy id")}`, {
    policyName: current.policyName, policy: { allowCustomProviders: false }, priority: 0, isEnabled: true, memberIds: [], teamIds: [], roles: [],
  })
  assert.equal(legacy.status, 200, summary(legacy))
  assert.deepEqual(await delivered(), { allowCustomProviders: false, allowLocalModels: false })

  assert.equal((await save({ allowCustomProviders: true, allowLocalModels: false })).status, 200)
  assert.deepEqual(await delivered(), { allowCustomProviders: true, allowLocalModels: false }, "personal keys on, Ollama off")
  assert.deepEqual(await delivered(owner), { allowCustomProviders: true, allowLocalModels: false }, "the owner's own desktop follows it too")

  // Model access is a desktop policy: owner-only by default. An admin is refused and changes nothing...
  const asAdmin = await save({ allowCustomProviders: true, allowLocalModels: true }, den.as(admin, org.orgId))
  assert.equal(asAdmin.status, 403, summary(asAdmin))
  assert.equal(field(asAdmin.body, "requiredPermission"), "desktop_policies.manage")
  assert.deepEqual(await delivered(), { allowCustomProviders: true, allowLocalModels: false })
  // ...but still receives the setting on their own desktop.
  assert.deepEqual(await delivered(den.as(admin, org.orgId)), { allowCustomProviders: true, allowLocalModels: false })

  assert.equal((await save({ allowCustomProviders: false, allowLocalModels: true })).status, 200)
  assert.deepEqual(await delivered(), { allowCustomProviders: false, allowLocalModels: true }, "only organization models, plus Ollama")
})

test("a plain member cannot change local models for anyone", { timeout: 60_000 }, async () => {
  const before = await delivered()
  const refused = await save({ allowCustomProviders: true, allowLocalModels: true }, memberCall)
  assert.equal(refused.status, 403, summary(refused))
  assert.deepEqual(await delivered(), before)
})

test("another organization is unaffected", { timeout: 60_000 }, async () => {
  const other = await den.createOrg(await den.signUp("Morgan Owner"), "Borealis")

  assert.deepEqual(await delivered(den.as(other.owner, other.orgId)), { allowCustomProviders: true, allowLocalModels: true })
})
