import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

for (const [key, value] of Object.entries({ OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den", DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890", BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!", BETTER_AUTH_URL: "http://localhost:8790" })) process.env[key] ??= value
const { headlessModelAttribution } = await import("../src/headless-runner/attribution.js")
const actor = { organizationId: createDenTypeId("organization"), userId: createDenTypeId("user") }
const memberId = createDenTypeId("member")

test("attribution is absent when rollout is off and no member identity is read", async () => {
  assert.equal(await headlessModelAttribution(actor, { enabled: async (org) => { assert.equal(org, actor.organizationId); return false }, member: async () => { assert.fail("off must not read identity") } }), undefined)
})

test("enabled attribution uses authoritative membership, scopes its lookup, and rechecks on every issuance", async () => {
  let enabled = true
  let reads = 0
  const deps = { enabled: async () => enabled, member: async (lookup: typeof actor) => { assert.deepEqual(lookup, actor); reads++; return { memberId, email: "person@example.test" } } }
  assert.deepEqual(await headlessModelAttribution(actor, deps), { ...actor, memberId, email: "person@example.test" })
  enabled = false
  assert.equal(await headlessModelAttribution(actor, deps), undefined)
  assert.equal(reads, 1, "turning off stops new disclosures without caching a prior identity")
})

test("missing membership fails closed and non-header-safe email does not break opaque attribution", async () => {
  await assert.rejects(headlessModelAttribution(actor, { enabled: async () => true, member: async () => undefined }), /active membership/)
  assert.deepEqual(await headlessModelAttribution(actor, { enabled: async () => true, member: async () => ({ memberId, email: "person\r\nx-key: secret" }) }), { ...actor, memberId })
})
