import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { streamMcpDiscovery } from "../src/routes/org/mcp-discovery-stream.js"

const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)

test("SSE sends real early progress, then preserves check and result order", async () => {
  const release = Promise.withResolvers<void>()
  const app = new Hono()
  app.post("/discover/stream", c => streamSSE(c, stream => streamMcpDiscovery({
    stream, signal: c.req.raw.signal,
    discover: async (_signal, onCheck) => {
      onCheck({ id: "server", status: "running" })
      await release.promise
      onCheck({ id: "server", status: "passed", httpStatus: 401, code: "authentication_required" })
      return { status: "manual_action_required" }
    },
  })))
  const response = await app.request("/discover/stream", { method: "POST" })
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  const reader = response.body?.getReader()
  assert.ok(reader)
  const early = decode((await reader.read()).value)
  assert.equal(early, 'event: check\ndata: {"id":"server","status":"running"}\n\n')
  release.resolve()
  let remaining = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    remaining += decode(next.value)
  }
  assert.equal(remaining, 'event: check\ndata: {"id":"server","status":"passed","httpStatus":401,"code":"authentication_required"}\n\nevent: result\ndata: {"status":"manual_action_required"}\n\n')
})

test("SSE errors use only the generic message, never network errors or credentials", async () => {
  const app = new Hono()
  app.post("/", c => streamSSE(c, stream => streamMcpDiscovery({ stream, signal: c.req.raw.signal, discover: async () => {
    throw new Error("https://user:private-synthetic-secret@internal.example?access_token=private")
  } })))
  const response = await app.request("/", { method: "POST" })
  assert.equal(await response.text(), 'event: error\ndata: {"message":"The server check could not finish. Try again."}\n\n')
})

test("SSE disconnect cancels work and drops late callbacks and terminal events", async () => {
  const aborted = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const app = new Hono()
  app.post("/", c => streamSSE(c, async stream => {
    await streamMcpDiscovery({ stream, signal: c.req.raw.signal, discover: async (signal, onCheck) => {
      onCheck({ id: "server", status: "running" })
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted.resolve(); resolve() }, { once: true }))
      onCheck({ id: "server", status: "passed" })
      throw new Error("late private detail")
    } })
    finished.resolve()
  }))
  const response = await app.request("/", { method: "POST" })
  const reader = response.body?.getReader()
  assert.ok(reader)
  assert.match(decode((await reader.read()).value), /running/)
  await reader.cancel()
  await aborted.promise
  await finished.promise
  assert.equal((await reader.read()).done, true)
})

test("stream route keeps JSON request validation, header boundaries, caller filtering and caller authorization", async () => {
  // Registration is covered without importing the database/auth composition root.
  const source = await readFile(new URL("../src/routes/org/mcp-connections.ts", import.meta.url), "utf8")
  const start = source.indexOf('"/v1/mcp-connections/discover/stream"')
  const route = source.slice(start, source.indexOf('"/v1/mcp-connections/:connectionId/oauth/issuer-review"', start))
  assert.match(route, /orgMemberRoute\(\),\s+jsonValidator\(discoverConnectionBodySchema\)/)
  assert.match(route, /validateExternalMcpRequestHeaders\(requestHeaders \?\? \[\], "discover"\)/)
  assert.match(route, /withExternalMcpRequestHeaders\(externalMcpDiscoveryFetch, url, discoveryHeaders.headers\)/)
  assert.match(route, /hasPermission\(c, "connections.view"\)/)
  assert.match(route, /requirementsForCaller\(await discoverConnectionRequirements/)
  assert.match(route, /"text\/event-stream"/)
  assert.match(route, /const response = streamSSE\([\s\S]*response\.headers\.set\("Cache-Control", "no-store"\)\s+return response/)
})
