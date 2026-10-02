import assert from "node:assert/strict"
import { test } from "node:test"
import { createFreeCapacity, FreeAutoBusyError } from "../src/free/shared/capacity.js"

test("free Auto runs a bounded amount of work at once and turns the rest away instead of queueing without limit", async () => {
  const capacity = createFreeCapacity({ maxActive: 2, maxQueued: 1 })
  const gates: Array<() => void> = []
  const hold = () => capacity.run(() => new Promise<string>((resolve) => gates.push(() => resolve("done"))))
  const first = hold(), second = hold(), waiting = hold()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(capacity.active, 2)
  assert.equal(capacity.queued, 1)
  await assert.rejects(hold(), (error: unknown) => error instanceof FreeAutoBusyError && error.status === 503 && error.code === "free_auto_busy")
  gates.shift()?.()
  assert.equal(await first, "done")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(capacity.active, 2, "the queued request took the freed slot")
  assert.equal(capacity.queued, 0)
  while (gates.length) gates.shift()?.()
  assert.deepEqual(await Promise.all([second, waiting]), ["done", "done"])
  assert.equal(capacity.active, 0)
  await assert.rejects(capacity.run(async () => { throw new Error("boom") }), /boom/)
  assert.equal(capacity.active, 0, "a failed task releases its slot")
})
