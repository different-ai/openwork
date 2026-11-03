import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { createEnterpriseMcpClient } from "../../../../packages/enterprise-mcp-client/src/enterprise-mcp-client.js"
import type { EnterpriseMcpFetch } from "../../../../packages/enterprise-mcp-client/src/contracts.js"

const serverUrl = "https://gateway.example/mcp"
const connection = { id: "emc_fixture", serverUrl, authorization: { type: "api-key" as const, token: "fixture-key" } }
const redirectUri = "https://den.example/v1/mcp-connections/oauth/callback"

/**
 * A stateful Streamable HTTP gateway that allows `cap` open sessions, like
 * hosted gateways that refuse new sessions until old ones end or expire.
 */
function statefulGateway(input: { cap: number; deleteStatus?: number; hangDelete?: boolean; listStatus?: number; toolError?: boolean }) {
  const open = new Set<string>()
  const deletes: number[] = []
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })
  const fetch: EnterpriseMcpFetch = async (_url, init) => {
    const session = new Headers(init?.headers).get("mcp-session-id")
    if (init?.method === "DELETE") {
      if (input.hangDelete) {
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }))
      }
      const status = input.deleteStatus ?? 200
      deletes.push(status)
      if (status === 200 && session) open.delete(session)
      return new Response(null, { status })
    }
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
    if (message.method === "server/discover") return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
    if (message.method === "initialize") {
      if (open.size >= input.cap) return json({ error: "too many sessions" }, 503)
      const id = randomUUID()
      open.add(id)
      return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gateway", version: "1" } } }, 200, { "mcp-session-id": id })
    }
    if (!session || !open.has(session)) return json({ error: "unknown session" }, 404)
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === "tools/list") {
      if (input.listStatus) return json({ error: "upstream failed" }, input.listStatus)
      return json({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } })
    }
    if (message.method === "tools/call") {
      return json({ jsonrpc: "2.0", id: message.id, result: { isError: Boolean(input.toolError), content: [{ type: "text", text: "done" }] } })
    }
    return json({ jsonrpc: "2.0", id: message.id, result: {} })
  }
  return { fetch, open, deletes }
}

test("repeated discovery and tool calls end their sessions, so a one-session gateway keeps working", async () => {
  const gateway = statefulGateway({ cap: 1 })
  const client = createEnterpriseMcpClient({ fetch: gateway.fetch })
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await client.connect({ connection, redirectUri })).status, "connected")
    assert.deepEqual((await client.listTools({ connection, redirectUri })).map((tool) => tool.name), ["lookup"])
    await client.callTool({ connection, redirectUri, toolName: "lookup", arguments: {} })
  }
  assert.equal(gateway.open.size, 0)
  assert.deepEqual(gateway.deletes, Array(9).fill(200))
})

test("a gateway that refuses DELETE stays usable and the operation result is unchanged", async () => {
  const gateway = statefulGateway({ cap: 10, deleteStatus: 405 })
  const client = createEnterpriseMcpClient({ fetch: gateway.fetch })
  assert.equal((await client.listTools({ connection, redirectUri })).length, 1)
  await client.callTool({ connection, redirectUri, toolName: "lookup", arguments: {} })
  assert.deepEqual(gateway.deletes, [405, 405])
})

test("a slow DELETE is bounded and never fails a successful call", async () => {
  const gateway = statefulGateway({ cap: 10, hangDelete: true })
  const client = createEnterpriseMcpClient({ fetch: gateway.fetch, closeTimeoutMs: 50 })
  const started = Date.now()
  assert.equal((await client.listTools({ connection, redirectUri })).length, 1)
  assert.ok(Date.now() - started < 2_000)
})

test("a failure after the session started still ends it, and the original error is kept", async () => {
  const listing = statefulGateway({ cap: 1, listStatus: 500, deleteStatus: 500 })
  const client = createEnterpriseMcpClient({ fetch: listing.fetch })
  await assert.rejects(client.listTools({ connection, redirectUri }), { requestPhase: "mcp-tool-discovery" })
  assert.deepEqual(listing.deletes, [500])

  const tool = statefulGateway({ cap: 1, toolError: true })
  const toolClient = createEnterpriseMcpClient({ fetch: tool.fetch })
  const toolFailure = (error: unknown) => error instanceof Error && error.cause instanceof Error && error.cause.name === "EnterpriseMcpToolResultError"
  // The second call needs the first call's session to have ended.
  await assert.rejects(toolClient.callTool({ connection, redirectUri, toolName: "lookup", arguments: {} }), toolFailure)
  await assert.rejects(toolClient.callTool({ connection, redirectUri, toolName: "lookup", arguments: {} }), toolFailure)
  assert.equal(tool.open.size, 0)
})
