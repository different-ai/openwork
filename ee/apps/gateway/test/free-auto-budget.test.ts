import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { createDenDb } from "@openwork-ee/den-db"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { readAutoConfig } = await import("../src/free/shared/config.js")
const { maximumCompletionCost, reserveMemberBudget, settleMemberBudget } = await import("../src/free/member/shared-budget.js")
const config = readAutoConfig({ INFERENCE_FREE_ORG_WEEKLY_MICRO_USD: "100" })
test("a reservation covers a single bounded Luna completion", () => {
  assert.ok((maximumCompletionCost(config, 1) ?? 0) > 0)
  assert.equal(maximumCompletionCost(config, 2), null)
  assert.equal(maximumCompletionCost({ ...config, upstreamModel: "unknown" }, 1), null)
})

test("members racing for the same org budget share one reservation", { skip: !process.env.FREE_BUDGET_TEST_DATABASE_URL }, async () => {
  const { db, client } = createDenDb({ databaseUrl: process.env.FREE_BUDGET_TEST_DATABASE_URL })
  const organizationId = createDenTypeId("organization")
  const members = Array.from({ length: 2 }, () => ({ kind: "member" as const, id: createDenTypeId("user"),
    memberId: createDenTypeId("member"), inferenceKeyId: createDenTypeId("inferenceKey"), organizationId }))
  const requests = members.map(() => randomUUID())
  try {
    const results = await Promise.all(members.map((member, i) => db.transaction(tx =>
      reserveMemberBudget(tx, member, config, requests[i], config.orgWeeklyAmount))))
    assert.deepEqual(results.toSorted(), ["free_org_budget_exhausted", null].sort())
    const winner = results.indexOf(null)
    const release = () => db.transaction(tx => settleMemberBudget(tx, members[winner], config, requests[winner], null, true))
    await release()
    await release()
    assert.equal(await db.transaction(tx => reserveMemberBudget(tx, members[1 - winner], config, randomUUID(), config.orgWeeklyAmount)), null)
  } finally { if ("end" in client) await client.end() }
})
