import assert from "node:assert/strict"
import test from "node:test"
import { DatabaseError } from "@planetscale/database"
import { createDenDb, isTransientDbConnectionError } from "../src/client.js"
import { createRetryingPlanetScaleFetch } from "../src/transient-retry.js"

function successfulQueryResponse(): Response {
  return new Response(
    JSON.stringify({
      result: {
        fields: [],
        insertId: "0",
        rows: [],
        rowsAffected: "0",
      },
      timing: 0,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function unavailableResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "internal", message: "Service Unavailable" } }), {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "content-type": "application/json" },
  })
}

test("classifies transient database transport errors through nested causes", () => {
  assert.equal(isTransientDbConnectionError({ status: 503 }), true)
  assert.equal(isTransientDbConnectionError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), true)
  assert.equal(isTransientDbConnectionError({ code: "ER_PARSE_ERROR", status: 400 }), false)
  assert.equal(isTransientDbConnectionError(new Error("query failed")), false)
})

test("PlanetScale retries a transient read response once", async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: string[] = []
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return attempts === 1 ? unavailableResponse() : successfulQueryResponse()
  }
  console.warn = (message) => warnings.push(String(message))

  try {
    const { client } = createDenDb({
      mode: "planetscale",
      planetscale: { host: "example.test", username: "user", password: "password" },
    })
    await client.execute("select 1")

    assert.equal(attempts, 2)
    assert.deepEqual(warnings, ["[db] transient database error on execute (SELECT); retrying once"])
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test("PlanetScale does not retry writes", async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return unavailableResponse()
  }

  try {
    const { client } = createDenDb({
      mode: "planetscale",
      planetscale: { host: "example.test", username: "user", password: "password" },
    })
    await assert.rejects(client.execute("insert into example values (1)"), (error: unknown) => {
      assert.equal(error instanceof DatabaseError && error.status === 503, true)
      return true
    })
    assert.equal(attempts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PlanetScale surfaces the second transient read failure", async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return unavailableResponse()
  }
  console.warn = () => undefined

  try {
    const { client } = createDenDb({
      mode: "planetscale",
      planetscale: { host: "example.test", username: "user", password: "password" },
    })
    await assert.rejects(client.execute("select 1"), (error: unknown) => {
      assert.equal(error instanceof DatabaseError && error.status === 503, true)
      return true
    })
    assert.equal(attempts, 2)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})


test("PlanetScale releases the first response before retry and preserves the second error body", async () => {
  const originalFetch = globalThis.fetch
  let cancelled = false
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 })
    assert.equal(cancelled, true)
    return unavailableResponse()
  }
  try {
    const response = await createRetryingPlanetScaleFetch()("https://example.test", { body: JSON.stringify({ query: "select 1" }) })
    assert.equal(attempts, 2)
    assert.equal(response.status, 503)
    assert.match(await response.text(), /Service Unavailable/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PlanetScale preserves non-transient responses and malformed request bodies without retry", async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const body of [undefined, "{", JSON.stringify({}), JSON.stringify({ query: 1 }), JSON.stringify({ query: "insert into example values (1)" })]) {
      let attempts = 0
      globalThis.fetch = async () => { attempts += 1; return unavailableResponse() }
      const response = await createRetryingPlanetScaleFetch()("https://example.test", { body })
      assert.equal(response.status, 503)
      assert.equal(attempts, 1)
    }
    for (const status of [400, 401, 403, 404, 422]) {
      let attempts = 0
      globalThis.fetch = async () => { attempts += 1; return new Response("denied", { status }) }
      const response = await createRetryingPlanetScaleFetch()("https://example.test", { body: JSON.stringify({ query: "select 1" }) })
      assert.equal(response.status, status)
      assert.equal(await response.text(), "denied")
      assert.equal(attempts, 1)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("PlanetScale retries nested transport failures only for reads and only once", async () => {
  const originalFetch = globalThis.fetch
  const fault = new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } })
  try {
    for (const query of ["select 1", "insert into example values (1)"]) {
      let attempts = 0
      globalThis.fetch = async () => { attempts += 1; throw fault }
      await assert.rejects(createRetryingPlanetScaleFetch()("https://example.test", { body: JSON.stringify({ query }) }), (error) => error === fault)
      assert.equal(attempts, query === "select 1" ? 2 : 1)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
