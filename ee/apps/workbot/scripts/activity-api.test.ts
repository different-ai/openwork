import assert from "node:assert/strict"
import { test } from "node:test"
import { workbotActivityFaultResponses } from "./activity-api-fixture.ts"

test("the shipped routes report unknown reads and unconfirmed stops inside HTTP 200 envelopes", async () => {
  const result = await workbotActivityFaultResponses()
  assert.deepEqual(result.unavailable, { status: 200, payload: { available: false, reason: "workbot_runner_unavailable" } })
  assert.deepEqual(result.stop, { status: 200, payload: { stopped: false } })
  assert.deepEqual(result.taskStop, { status: 200, payload: { stopped: false } })
  assert.equal(result.runnerRequests.filter(path => path.startsWith("POST ") && path.includes("/abort")).length, 2)
  assert.ok(result.runnerRequests.some(path => path.startsWith("GET ") && path.includes("/sessions/")))
})
