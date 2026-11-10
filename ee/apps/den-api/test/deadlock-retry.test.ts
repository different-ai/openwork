import assert from "node:assert/strict"
import { test } from "node:test"
import { withDeadlockRetry } from "../src/utils/deadlock-retry.js"

// The error the Stripe webhook reported when concurrent deliveries for a new
// subscription upserted the same org_subscriptions row (DEN-API-6B).
function stripeSubscriptionUpsertDeadlock() {
  const cause = Object.assign(new Error(
    "target: den.-.primary: vttablet: rpc error: code = Aborted desc = Deadlock found when trying to get lock; try restarting transaction (errno 1213) (sqlstate 40001) (CallerID: caller): Sql: \"insert into org_subscriptions(id) values (:vtg1) on duplicate key update `status` = :status\", BindVars: {REDACTED}",
  ), { name: "DatabaseError" })
  return new Error("Failed query: insert into `org_subscriptions` (`id`) values (?) on duplicate key update `status` = ?\nparams: [redacted]", { cause })
}

test("a deadlocked subscription upsert is read and written again", async () => {
  let attempts = 0
  const row = await withDeadlockRetry(async () => {
    if (++attempts === 1) throw stripeSubscriptionUpsertDeadlock()
    return "subscription row"
  })
  assert.equal(row, "subscription row")
  assert.equal(attempts, 2)
})

test("a persistent deadlock still fails after three attempts so Stripe redelivers", async () => {
  const error = stripeSubscriptionUpsertDeadlock()
  let attempts = 0
  await assert.rejects(withDeadlockRetry(async () => { attempts++; throw error }), (caught) => caught === error)
  assert.equal(attempts, 3)
})
