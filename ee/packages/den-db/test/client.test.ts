import assert from "node:assert/strict"
import test from "node:test"
import { createDenDb } from "../src/client.js"
import { createRetryingPlanetScaleFetch } from "../src/transient-retry.js"

const fault = new TypeError("synthetic socket reset", { cause: { code: "UND_ERR_SOCKET" } })
const request = (query = "select 1", session: unknown = null) => ({
  method: "POST", headers: {}, body: JSON.stringify({ query, session }),
})
const success = () => new Response(JSON.stringify({ result: { fields: [], rows: [], rowsAffected: "0", insertId: "0" }, timing: 0 }))

test("the real PlanetScale client recovers one standalone transport failure", async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => { if (++attempts === 1) throw fault; return success() }
  try {
    const { client } = createDenDb({ mode: "planetscale", planetscale: { host: "example.test", username: "synthetic", password: "synthetic" } })
    await client.execute("select id from example where (id = 1)")
    assert.equal(attempts, 2)
  } finally { globalThis.fetch = original }
})

test("HTTP errors retain their exact response and body without retry or cancellation", async () => {
  const original = globalThis.fetch
  try {
    for (const status of [400, 401, 403, 408, 429, 500, 502, 503, 504]) {
      let attempts = 0
      const response = new Response("original failure", { status, headers: { "retry-after": "30" } })
      globalThis.fetch = async () => { attempts++; return response }
      const result = await createRetryingPlanetScaleFetch()("https://example.test", request())
      assert.equal(result, response)
      assert.equal(await result.text(), "original failure")
      assert.equal(attempts, 1)
    }
  } finally { globalThis.fetch = original }
})

test("transactions, locking reads, statements, functions, comments and ambiguous SQL never retry", async () => {
  const original = globalThis.fetch
  try {
    for (const init of [
      request("select 1", "transaction-session"), request("select 1", {}),
      request("select 1 for update"), request("select 1 for share"), request("select 1 lock in share mode"),
      request("select 1; delete from example"), request("select 1;"), request("select get_lock('synthetic', 1)"),
      request("select @value := 1"), request("select 1 into @value"), request("select /* comment */ 1"), request("select 1 -- comment"),
      request("selectivity"), request("explain select 1"), request("show tables"),
      request("insert into example values (1)"), request("update example set value=1"), request("delete from example"),
      request("BEGIN"), request("COMMIT"), request("ROLLBACK"),
      { ...request(), body: "{" }, { ...request(), body: JSON.stringify({ query: "select 1" }) },
    ]) {
      let attempts = 0
      globalThis.fetch = async () => { attempts++; throw fault }
      await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", init), (error) => error === fault)
      assert.equal(attempts, 1, init.body)
    }
  } finally { globalThis.fetch = original }
})

test("retry failure preserves the original transport error", async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => { if (++attempts === 1) throw fault; throw new Error("second failure") }
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", request()), (error) => error === fault)
    assert.equal(attempts, 2)
  } finally { globalThis.fetch = original }
})

test("slow first failures do not spend another retry budget", async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => { attempts++; await new Promise((resolve) => setTimeout(resolve, 300)); throw fault }
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", request()), (error) => error === fault)
    assert.equal(attempts, 1)
  } finally { globalThis.fetch = original }
})

test("abort during the first failure prevents replay and preserves cancellation", async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  const reason = new Error("synthetic cancellation")
  let attempts = 0
  globalThis.fetch = async () => { attempts++; controller.abort(reason); throw fault }
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", { ...request(), signal: controller.signal }), (error) => error === reason)
    assert.equal(attempts, 1)
  } finally { globalThis.fetch = original }
})

test("DNS, timeouts, authorization and cyclic causes are not transient socket failures", async () => {
  const original = globalThis.fetch
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  try {
    for (const error of [{ code: "ENOTFOUND" }, { code: "ECONNREFUSED" }, { code: "UND_ERR_CONNECT_TIMEOUT" }, { name: "AbortError", cause: fault }, { status: 403, cause: fault }, cycle]) {
      let attempts = 0
      globalThis.fetch = async () => { attempts++; throw error }
      await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", request()), (caught) => caught === error)
      assert.equal(attempts, 1)
    }
  } finally { globalThis.fetch = original }
})

test("real SDK transactions roll back after a read failure without replaying the statement", async () => {
  const original = globalThis.fetch
  const queries: string[] = []
  globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, "string")
    const payload: unknown = JSON.parse(String(init?.body))
    assert.ok(typeof payload === "object" && payload !== null && "query" in payload && typeof payload.query === "string")
    queries.push(payload.query)
    if (payload.query === "select 1") throw fault
    return new Response(JSON.stringify({ result: { fields: [], rows: [], rowsAffected: "0", insertId: "0" }, session: "synthetic-transaction" }))
  }
  try {
    const { client } = createDenDb({ mode: "planetscale", planetscale: { host: "example.test", username: "synthetic", password: "synthetic" } })
    await assert.rejects(client.transaction(async (tx) => { await tx.execute("select 1") }), (error) => error === fault)
    assert.deepEqual(queries, ["BEGIN", "select 1", "ROLLBACK"])
  } finally { globalThis.fetch = original }
})

test("cancellation during backoff prevents the second fetch", async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  const reason = new Error("cancelled during backoff")
  let attempts = 0
  globalThis.fetch = async () => { attempts++; throw fault }
  const timer = setTimeout(() => controller.abort(reason), 10)
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", { ...request(), signal: controller.signal }), (error) => error === reason)
    assert.equal(attempts, 1)
  } finally { clearTimeout(timer); globalThis.fetch = original }
})

test("the second fetch receives a deadline and expiry preserves the original failure", async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async (_input, init) => {
    if (++attempts === 1) throw fault
    assert.ok(init?.signal)
    const signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  }
  // AbortSignal.timeout is unref'ed; keep this synthetic fetch alive like real I/O.
  const keepAlive = setTimeout(() => {}, 1000)
  const started = performance.now()
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", request()), (error) => error === fault)
    assert.equal(attempts, 2)
    assert.ok(performance.now() - started < 750)
  } finally { clearTimeout(keepAlive); globalThis.fetch = original }
})

test("an already aborted caller sends no database request", async () => {
  const original = globalThis.fetch
  const reason = new Error("already cancelled")
  let attempts = 0
  globalThis.fetch = async () => { attempts++; return success() }
  try {
    await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", { ...request(), signal: AbortSignal.abort(reason) }), (error) => error === reason)
    assert.equal(attempts, 0)
  } finally { globalThis.fetch = original }
})

test("a response body failure is preserved without replaying its query", async () => {
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => { attempts++; return new Response(new ReadableStream({ start(controller) { controller.error(fault) } })) }
  try {
    const { client } = createDenDb({ mode: "planetscale", planetscale: { host: "example.test", username: "synthetic", password: "synthetic" } })
    await assert.rejects(client.execute("select 1"), (error) => error === fault)
    assert.equal(attempts, 1)
  } finally { globalThis.fetch = original }
})
