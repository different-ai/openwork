import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createEnterpriseMcpClient } from "../../../../packages/enterprise-mcp-client/src/enterprise-mcp-client.js"
import type { EnterpriseMcpConnection, EnterpriseMcpFetch } from "../../../../packages/enterprise-mcp-client/src/contracts.js"

const connection: EnterpriseMcpConnection = { id: "event-server", serverUrl: "https://events.example/mcp", authorization: { type: "api-key", token: "fixture-key" } }
const redirectUri = "https://den.example/oauth/callback"
const requestSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() })

function eventServer(input: { modern?: boolean; sse?: boolean; capabilities?: Record<string, unknown>; enabled?: boolean } = {}) {
  const requests: { method: string; headers: Headers; params?: Record<string, unknown> }[] = []
  const fetch: EnterpriseMcpFetch = async (_url, init) => {
    if (init?.method !== "POST") return new Response(null, { status: 405 })
    assert.equal(typeof init.body, "string")
    const request = requestSchema.parse(JSON.parse(String(init.body)))
    requests.push({ method: request.method, params: request.params, headers: new Headers(init.headers) })
    const respond = (result: Record<string, unknown>, error = false) => {
      const message = JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error: result } : { result }) })
      return new Response(input.sse ? `event: message\ndata: ${message}\n\n` : message, { headers: { "content-type": input.sse ? "text/event-stream" : "application/json" } })
    }
    if (request.id === undefined) return new Response(null, { status: 202 })
    const capabilities = input.capabilities ?? { events: {} }
    if (request.method === "server/discover") return input.modern
      ? respond({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities })
      : respond({ code: -32601, message: "Method not found" }, true)
    if (request.method === "initialize") return respond({ protocolVersion: "2025-06-18", capabilities, serverInfo: { name: "event-server", version: "1" } })
    return respond({ ...(input.modern ? { resultType: "complete" } : {}), events: [] })
  }
  return { requests, client: createEnterpriseMcpClient({ fetch, webhookEvents: input.enabled ?? true, operationTimeoutMs: 2_000 }) }
}

for (const modern of [false, true]) {
  for (const sse of [false, true]) {
    for (const capabilities of [{ events: {} }, { extensions: { "io.modelcontextprotocol/events": {} } }]) {
      test(`event capability works through ${modern ? "discover" : "initialize"} ${sse ? "SSE" : "JSON"} with ${"events" in capabilities ? "legacy" : "namespaced"} advertisement`, async () => {
        const server = eventServer({ modern, sse, capabilities })
        assert.deepEqual(await server.client.requestEvents({ connection, redirectUri, method: "events/list", params: {} }), { events: [] })
        const listings = server.requests.filter((request) => request.method === "events/list")
        assert.equal(listings.length, 1)
        assert.equal(listings[0]?.headers.get("Mcp-Method"), "events/list")
        assert.equal(listings[0]?.headers.get("Mcp-Name"), null)
      })
    }
  }
  test(`events are not probed on an unadvertised ${modern ? "modern" : "legacy"} server`, async () => {
    const server = eventServer({ modern, capabilities: { tools: {} } })
    await assert.rejects(server.client.requestEvents({ connection, redirectUri, method: "events/list", params: {} }))
    assert.equal(server.requests.some((request) => request.method.startsWith("events/")), false)
  })
}

test("event calls remain disabled without the client opt-in", async () => {
  const server = eventServer({ enabled: false })
  await assert.rejects(server.client.requestEvents({ connection, redirectUri, method: "events/list", params: {} }), /not enabled/)
  assert.equal(server.requests.length, 0)
})

for (const name of ["document.changed", "文書.changed", "=?base64?YWJj?=", " leading-space"]) {
  for (const method of ["events/subscribe", "events/unsubscribe"] satisfies ("events/subscribe" | "events/unsubscribe")[]) {
    test(`${method} supplies the MCP routing header for ${name}`, async () => {
      const server = eventServer({ modern: true, capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } })
      await server.client.requestEvents({ connection, redirectUri, method, params: { name } })
      const headers = server.requests.find((request) => request.method === method)?.headers
      const expected = name === "document.changed" ? name : `=?base64?${Buffer.from(name).toString("base64")}?=`
      assert.equal(headers?.get("Mcp-Method"), method)
      assert.equal(headers?.get("Mcp-Name"), expected)
    })
  }
}
