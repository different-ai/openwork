import assert from "node:assert/strict"
import { test } from "node:test"
import { FreestyleApiError } from "freestyle"
import { createFreestyleProvider, freestyleError } from "./index.js"
const p = createFreestyleProvider({ apiKey: "not-used", snapshot: "freestyle/ubuntu-sm", firewall: { rules: [] } })
test("unsupported create-time configuration fails before provisioning", async () => {
  const spec = { workerId: "", idempotencyKey: "test", image: null, env: { KEY: "value" }, labels: {}, storage: [], exposePorts: [] }
  await assert.rejects(p.create(spec, { timeoutMs: 1000 }), /create-time env/)
})
test("unsupported endpoint and volume bindings fail explicitly", async () => {
  // No handles are used in the endpoint callback, and no SDK request is made.
  await assert.rejects(p.storage.ensureVolume("test", { timeoutMs: 1000 }), /volumes/)
  assert.equal(p.describe().endpoints, false)
  assert.equal(p.describe().createEnvironment, false)
})
test("stable HTTP errors are normalized without parsing prose", () => {
  for (const [status, expected] of [[404, "not_found"], [409, "conflict"], [403, "auth"], [429, "rate_limited"], [503, "transient"]]) {
    const error = freestyleError(new FreestyleApiError(Number(status), { code: "ERROR", message: "arbitrary" }))
    assert.equal(error.code, expected)
    assert.equal(error.providerId, "freestyle")
  }
})
