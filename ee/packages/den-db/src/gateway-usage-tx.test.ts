import assert from "node:assert/strict"
import { test } from "node:test"
import { runGatewayUsageTransaction, type GatewayUsageTransactionDb } from "./gateway-usage-tx"

const deadlock = () => Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK" })

function fakeDb(failures: Error[]) {
  let attempts = 0
  const db: GatewayUsageTransactionDb<string> = {
    async transaction(run) {
      attempts += 1
      const failure = failures.shift()
      if (failure) throw failure
      return run(`tx-${attempts}`)
    },
  }
  return { db, attempts: () => attempts }
}

test("runs the transaction with the clock's time", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z")
  const { db, attempts } = fakeDb([])
  const result = await runGatewayUsageTransaction(db, () => now, async (tx, at) => `${tx}@${at.toISOString()}`)
  assert.equal(result, "tx-1@2026-01-01T00:00:00.000Z")
  assert.equal(attempts(), 1)
})

test("retries a deadlock twice with a growing backoff", async () => {
  const sleeps: number[] = []
  const { db, attempts } = fakeDb([deadlock(), Object.assign(new Error("wrapped"), { cause: { errno: 1213 } })])
  const result = await runGatewayUsageTransaction(db, () => new Date(), async (tx) => tx, async (ms) => { sleeps.push(ms) })
  assert.equal(result, "tx-3")
  assert.equal(attempts(), 3)
  assert.deepEqual(sleeps, [5, 10])
})

test("gives up after the third deadlock", async () => {
  const third = deadlock()
  const { db, attempts } = fakeDb([deadlock(), deadlock(), third])
  await assert.rejects(runGatewayUsageTransaction(db, () => new Date(), async (tx) => tx, async () => {}), (error) => error === third)
  assert.equal(attempts(), 3)
})

test("does not retry other errors", async () => {
  const failure = Object.assign(new Error("timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" })
  const { db, attempts } = fakeDb([failure])
  await assert.rejects(runGatewayUsageTransaction(db, () => new Date(), async (tx) => tx, async () => {}), (error) => error === failure)
  assert.equal(attempts(), 1)
})
