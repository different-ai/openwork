import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field } from "./harness.js"

const den = await bootDen()
// Sign up first, as other API tests do: it settles the app's start-up work so
// none of it is still using the database pool when the test closes it.
await den.signUp("Ready Probe")
after(() => den.close())

test("/ready answers 503 once the instance starts draining, while /health stays up", async () => {
  const ready = await den.request(null, "GET", "/ready")
  assert.equal(ready.status, 200)
  assert.equal(field(ready.body, "ok"), true)
  assert.equal(field(ready.body, "draining"), undefined)

  const { markDraining } = await import("../../src/drain-state.js")
  markDraining()

  const draining = await den.request(null, "GET", "/ready")
  assert.equal(draining.status, 503)
  assert.equal(field(draining.body, "ok"), false)
  assert.equal(field(draining.body, "draining"), true)
  assert.equal(field(draining.body, "checks", "database"), "ok")

  const health = await den.request(null, "GET", "/health")
  assert.equal(health.status, 200, "liveness is unchanged: the process is healthy, just finishing up")
})
