import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { InferenceKeyTable } from "@openwork-ee/den-db/schema"
import { readFreeInferenceConfig, freeInferenceDefaultPinned, withFreeInferenceDefaultPinned, freeInferenceOrganizationAllowed, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { inferenceBearerKey, inferenceBearerKeyStorageDigest } from "@openwork-ee/utils/inference-bearer-key"

type Query = { from: () => Query; innerJoin: () => Query; leftJoin: () => Query; where: () => Query; limit: () => Query;
  for: () => Promise<unknown[]>; then: Promise<unknown[]>["then"] }
let results: unknown[][] = []
let failRead = false
const writes: Array<{ table: unknown; value: unknown }> = []
function select(): Query {
  if (failRead) throw new Error("Accounting unavailable")
  const value = results.shift()
  if (!value) throw new Error("Unexpected fixture query")
  const promise = Promise.resolve(value)
  const query: Query = { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query,
    limit: () => query, for: () => promise, then: promise.then.bind(promise) }
  return query
}
const transaction = {
  select,
  insert: (table: unknown) => ({ values: async (value: unknown) => { writes.push({ table, value }) } }),
  update: (table: unknown) => ({ set: (value: unknown) => ({ where: async () => { writes.push({ table, value }) } }) }),
}
const database = { ...transaction, transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) => callback(transaction) }
const configuration = { inferenceFree: readFreeInferenceConfig({ INFERENCE_FREE_ENABLED: "true" }), modelsPublicBaseUrl: "https://inference.example.test" }
mock.module("../src/db.js", () => ({ db: database }))
mock.module("../src/env.js", () => ({ env: configuration }))
const { getMemberInferenceAccess, ensureMemberFreeInferenceCredential, getFreeInferenceProviderSummary } = await import("../src/inference.js")
const input = { organizationId: createDenTypeId("organization"), memberId: createDenTypeId("member"), userId: createDenTypeId("user") }
const joinedAt = new Date("2026-09-01T00:00:00.000Z")
const person = { id: input.memberId, organizationId: input.organizationId, userId: input.userId, joinedAt, removedAt: null }
const now = new Date("2026-09-18T12:00:00.000Z")
beforeEach(() => {
  results = []
  writes.length = 0
  failRead = false
  configuration.inferenceFree = readFreeInferenceConfig({ INFERENCE_FREE_ENABLED: "true" })
})
afterAll(() => mock.restore())

test("disabled enrollment issues no key and touches no free tables", async () => {
  configuration.inferenceFree = readFreeInferenceConfig({})
  expect(await ensureMemberFreeInferenceCredential(input)).toBeNull()
  results = [[{ metadata: {}, nowMs: now.getTime() }]]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "unavailable", reason: "free_disabled", weeklyLimitUsd: 5, canUpgrade: false })
  expect(writes).toEqual([])
})

test("joined member of an unsubscribed organization gets an OpenWork Models key for the regular routes", async () => {
  results = [[{ metadata: {} }], [], [person], []]
  const credential = await ensureMemberFreeInferenceCredential(input)
  expect(credential?.apiKey).toMatch(/^ow_inf_/)
  expect(credential?.baseURL).toBe("https://inference.example.test/api/v1")
  expect(credential?.statusURL).toBe("https://inference.example.test/api/v1/auto/status")
  expect(writes).toHaveLength(1)
  expect(writes[0].table).toBe(InferenceKeyTable)
  expect(writes[0].value).toMatchObject({ organization_id: input.organizationId, org_membership_id: input.memberId, status: "active" })
})

test("credential issuance reuses the member's active key and rotates a key that no longer matches", async () => {
  const apiKey = `ow_inf_${"a".repeat(43)}`
  const existing = { id: "existing-key", encryptedKey: apiKey, keyHash: await inferenceBearerKeyStorageDigest(inferenceBearerKey(apiKey)) }
  results = [[{ metadata: {} }], [], [person], [existing]]
  expect((await ensureMemberFreeInferenceCredential(input))?.apiKey).toBe(apiKey)
  expect(writes).toEqual([])
  results = [[{ metadata: {} }], [], [person], [{ ...existing, keyHash: "stale" }]]
  expect((await ensureMemberFreeInferenceCredential(input))?.apiKey).not.toBe(apiKey)
  expect(writes.map((write) => write.table)).toEqual([InferenceKeyTable, InferenceKeyTable])
  expect(writes[0].value).toMatchObject({ status: "revoked" })
})

test("subscribed organizations use paid Models instead of free Auto", async () => {
  const subscribed = { inference: { enabled: true, tier: "tier1" } }
  results = [[{ metadata: subscribed }]]
  expect(await ensureMemberFreeInferenceCredential(input)).toBeNull()
  results = [[{ metadata: subscribed, nowMs: now.getTime() }]]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "paid", modelID: null, remainingUsd: null })
  expect(writes).toEqual([])
})

test("an organization Stripe still collects for is never downgraded to free Auto when its Models flag is lost", async () => {
  for (const status of ["active", "trialing", "past_due", "incomplete"]) {
    results = [[{ metadata: {} }], [{ status }]]
    expect(await ensureMemberFreeInferenceCredential(input)).toBeNull()
    results = [[{ metadata: {}, nowMs: now.getTime() }], [{ status }]]
    expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "unavailable", reason: "not_eligible" })
  }
  // Once Stripe has given up, the organization is unsubscribed and free Auto may serve it.
  results = [[{ metadata: {} }], [{ status: "canceled" }], [person], []]
  expect((await ensureMemberFreeInferenceCredential(input))?.apiKey).toMatch(/^ow_inf_/)
})

test("DPA policy rejects provisioning and status without touching paid credentials", async () => {
  results = [[{ metadata: { dpaSigned: true } }]]
  await expect(ensureMemberFreeInferenceCredential(input)).rejects.toMatchObject({ code: "managed_models_disabled_for_dpa" })
  results = [[{ metadata: { dpaSigned: true }, nowMs: now.getTime() }]]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "unavailable", reason: "admin_disabled", remainingUsd: null })
  expect(writes).toEqual([])
})

test("admin opt-out and missing active membership deny issuance", async () => {
  results = [[{ metadata: { inferenceFree: { offerAllowed: false } } }]]
  expect(await ensureMemberFreeInferenceCredential(input)).toBeNull()
  results = [[{ metadata: {} }], [], []]
  expect(await ensureMemberFreeInferenceCredential(input)).toBeNull()
  results = [[]]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "unavailable", reason: "not_eligible", remainingUsd: null })
  expect(writes).toEqual([])
})

test("member status includes cross-week pending state and never offers a paid model", async () => {
  results = [[{ metadata: {}, nowMs: now.getTime() }], [], [], [{ id: "old-week-pending" }], [{ blocked: false }]]
  const access = await getMemberInferenceAccess(input)
  expect(access).toMatchObject({ kind: "free", reason: "free_request_in_progress", canUpgrade: false, weeklyLimitUsd: 5 })
  expect(access.catalog?.map((model) => model.modelID)).toEqual(["openai/gpt-5.6-luna"])
  expect(writes).toEqual([])
})

test("Auto pin policy defaults on and updates only its metadata leaf", () => {
  const metadata = { dpaSigned: true, inference: { enabled: false }, inferenceFree: { offerAllowed: false, other: "retained" }, capabilities: { gatewayDashboard: false } }
  expect(freeInferenceDefaultPinned(null)).toBe(true)
  expect(freeInferenceDefaultPinned({})).toBe(true)
  const unpinned = withFreeInferenceDefaultPinned(metadata, false)
  expect(unpinned).toEqual({ ...metadata, inferenceFree: { ...metadata.inferenceFree, defaultPinned: false } })
  expect(freeInferenceDefaultPinned(unpinned)).toBe(false)
  expect(freeInferenceDefaultPinned(JSON.stringify(unpinned))).toBe(false)
  expect(() => freeInferenceDefaultPinned("{")).toThrow()
  expect(freeInferenceOrganizationAllowed(unpinned)).toBe(false)
  expect(freeInferenceOrganizationAllowed(JSON.stringify(unpinned))).toBe(false)
  expect(withFreeInferenceDefaultPinned(unpinned, true)).toEqual({ ...metadata, inferenceFree: { ...metadata.inferenceFree, defaultPinned: true } })
  expect(metadata.inferenceFree).not.toHaveProperty("defaultPinned")
})

test("member pin policy is authoritative without changing model availability", async () => {
  results = [[{ metadata: { inferenceFree: { defaultPinned: false } }, nowMs: now.getTime() }], [], [], [], []]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ defaultPinned: false, kind: "free", modelID: "openai/gpt-5.6-luna" })
  results = [[{ metadata: { dpaSigned: true, inferenceFree: { defaultPinned: true } }, nowMs: now.getTime() }]]
  expect(await getMemberInferenceAccess(input)).toMatchObject({ defaultPinned: true, kind: "unavailable", reason: "admin_disabled" })
  expect(writes).toEqual([])
})

test("organization summary uses recorded org usage, not members' person-wide balances", async () => {
  const otherUserId = createDenTypeId("user")
  const identity = freeInferenceDigest("member", input.userId)
  const unit = INFERENCE_USAGE_CONVERSION_FACTOR
  results = [[{ metadata: { inferenceFree: { defaultPinned: false } }, nowMs: now.getTime() }],
    [{ userId: input.userId }, { userId: otherUserId }, { userId: input.userId }],
    [{ identity_hash: identity, limit_amount: 5 * unit, used_amount: 5 * unit, reserved_amount: 0, blocked: false }],
    [{ blocked: false }], [{ usedAmount: String(unit), retainedAmount: "0", reservedAmount: String(unit / 2), requestCount: "3", invalidRows: "0" }]]
  const summary = await getFreeInferenceProviderSummary(input.organizationId)
  expect(summary).toMatchObject({ state: "available", defaultPinned: false, modelGroup: { id: "free", name: "Free" },
    allowance: { usageScope: "organization", allowanceScope: "person", joinedMembers: 2, eligibleMembers: 2, exhaustedMembers: 1, usedUsd: 1, reservedUsd: 0.5, retainedUsd: 0, requestCount: 3 } })
  expect(JSON.stringify(summary)).not.toContain(input.userId)
  expect(JSON.stringify(summary)).not.toContain(otherUserId)
  expect(writes).toEqual([])
})

test("disabled org summary preserves restrictions and does not read free accounting", async () => {
  results = [[{ metadata: { dpaSigned: true, inferenceFree: { defaultPinned: false } }, nowMs: now.getTime() }], [{ userId: input.userId }]]
  expect(await getFreeInferenceProviderSummary(input.organizationId)).toMatchObject({ state: "disabled", reason: "admin_disabled", defaultPinned: false,
    allowance: { joinedMembers: 1, eligibleMembers: 0, exhaustedMembers: null, usedUsd: null } })
  expect(results).toEqual([])
  expect(writes).toEqual([])
})

test("organization accounting uncertainty stays unknown instead of appearing unused", async () => {
  for (const usage of [
    { usedAmount: -1, retainedAmount: 0, reservedAmount: 0, requestCount: 1, invalidRows: 0 },
    { usedAmount: 0, retainedAmount: 0, reservedAmount: 0, requestCount: 1, invalidRows: 1 },
  ]) {
    results = [[{ metadata: {}, nowMs: now.getTime() }], [{ userId: input.userId }], [], [], [usage]]
    expect(await getFreeInferenceProviderSummary(input.organizationId)).toMatchObject({ state: "unavailable", reason: "accounting_unavailable", allowance: { usedUsd: null, exhaustedMembers: null } })
  }
  expect(writes).toEqual([])
})

test("accounting failures fail closed instead of inventing a balance", async () => {
  failRead = true
  expect(await getMemberInferenceAccess(input)).toMatchObject({ kind: "unavailable", reason: "accounting_unavailable", usedUsd: null, reservedUsd: null, remainingUsd: null })
  expect(writes).toEqual([])
})
