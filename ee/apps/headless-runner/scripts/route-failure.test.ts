import assert from "node:assert/strict"
import { test } from "node:test"
import { cellRouteFailure } from "../src/worker/route-failure.js"

/** Which of the cell host's errors mean "the cell could not be reached, send the request again". */

test("a node that is full is a cell to wait for", () => {
  // The message celld v0.6.x throws from a cell's fetch, as production logged it.
  assert.deepEqual(cellRouteFailure(new Error("route failed: CapacityExhausted")), { reason: "capacity_exhausted" })
})

test("a node that is restarting or lost its lease is a cell to wait for", () => {
  assert.deepEqual(cellRouteFailure(new Error("route failed: NodeFenced")), { reason: "node_fenced" })
  assert.deepEqual(cellRouteFailure(new Error("route failed: NodeUnavailable")), { reason: "node_unavailable" })
  assert.deepEqual(cellRouteFailure(new Error("route failed: RestoreFailed")), { reason: "restore_failed" })
  assert.deepEqual(cellRouteFailure(new Error("The Durable Object owner is currently unreachable")), { reason: "owner_unreachable" })
})

test("a cell that failed to start, or a write that may not be saved, stays an internal error", () => {
  assert.equal(cellRouteFailure(new Error("route failed: RuntimeFailed")), null)
  assert.equal(cellRouteFailure(new Error("route failed: DurabilityUnproven")), null)
})

test("anything else stays an internal error", () => {
  assert.equal(cellRouteFailure(new Error("route failed: SomethingNew")), null)
  assert.equal(cellRouteFailure(new Error("cells_require_s3_files")), null)
  assert.equal(cellRouteFailure(new Error("the request said: route failed: CapacityExhausted")), null)
  assert.equal(cellRouteFailure("route failed: CapacityExhausted"), null)
})

/** The router itself, with a cell host that fails the way celld does. */
const TOKEN = "t".repeat(40)
async function ask(failure: Error) {
  const { default: router } = await import("../src/worker/index.js")
  const env = {
    HEADLESS_API_TOKEN: TOKEN,
    HEADLESS_FILES: "off",
    HEADLESS_MODEL_PROTOCOL: "anthropic",
    HEADLESS_MODEL_BASE_URL: "https://models.test",
    HEADLESS_MODEL: "test-model",
    HEADLESS_CELL: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          throw failure
        },
      }),
    },
  }
  const logged = { warn: console.warn, error: console.error }
  console.warn = () => undefined
  console.error = () => undefined
  try {
    // The fake namespace stands in for celld's Durable Object binding.
    return await router.fetch(new Request("http://runner.test/v1/sessions/hs_abcdefgh12345678", { headers: { authorization: `Bearer ${TOKEN}` } }), env as never)
  } finally {
    console.warn = logged.warn
    console.error = logged.error
  }
}

test("the router tells the caller to send a request for an unreachable cell again", async () => {
  const response = await ask(new Error("route failed: CapacityExhausted"))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("retry-after"), "5")
  assert.deepEqual(await response.json(), { error: "cell_unavailable", reason: "capacity_exhausted" })
})

test("the router still answers any other failure as an internal error", async () => {
  const response = await ask(new Error("boom"))
  assert.equal(response.status, 500)
  assert.equal(response.headers.get("retry-after"), null)
  assert.deepEqual(await response.json(), { error: "internal_error" })
})
