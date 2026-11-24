import assert from "node:assert/strict"
import { createServer, type Server as HttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { getRequestListener } from "@hono/node-server"
import { createMcpHandler, Server } from "@modelcontextprotocol/server"
import { remoteMcpConnector } from "../src/mcp.js"

/**
 * The runner's MCP client negotiates the 2026-07-28 protocol where the server speaks it, so it hears
 * tools/list_changed while a connection is open, and still connects to a server that only speaks 2025's.
 */

async function listen(fetch: (request: Request) => Promise<Response>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: HttpServer = createServer(getRequestListener(fetch))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

const tool = (name: string) => ({ name, description: `${name} tool`, inputSchema: { type: "object" as const, properties: {} } })

function modernServer(tools: () => ReturnType<typeof tool>[]) {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "apps", version: "1" }, { capabilities: { tools: { listChanged: true } } })
    server.setRequestHandler("tools/list", async () => ({ tools: tools() }))
    server.setRequestHandler("tools/call", async (request) => ({ content: [{ type: "text", text: `ran ${request.params.name}` }] }))
    return server
  }, { legacy: "stateless" })
  return handler
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("a connection tells the runner when the server's tools change, and still lists and calls them", async (t) => {
  let tools = [tool("lookup")]
  const handler = modernServer(() => tools)
  const http = await listen((request) => handler.fetch(request))
  t.after(async () => {
    await handler.close()
    await http.close()
  })
  let changes = 0
  const connect = remoteMcpConnector({ url: http.url, allowlist: [], reservedNames: new Set() })
  const session = await connect({ token: "member-token", signal: new AbortController().signal, onToolsChanged: () => { changes += 1 } })
  t.after(() => session.close())

  assert.deepEqual(session.tools.map((spec) => spec.name), ["lookup"])
  assert.deepEqual(await session.call("lookup", {}, new AbortController().signal), { output: "ran lookup", isError: false })

  tools = [tool("lookup"), tool("send_email")]
  // The listen stream opens right after connect; give it a moment before the change.
  await new Promise((resolve) => setTimeout(resolve, 50))
  handler.notify.toolsChanged()
  await until(() => changes === 1, "tools/list_changed")
})

test("without a change callback the connection does not listen, and works the same", async (t) => {
  const handler = modernServer(() => [tool("lookup")])
  const methods: string[] = []
  const http = await listen(async (request) => {
    const body = request.method === "POST" ? await request.clone().json().catch(() => null) : null
    if (body && typeof body === "object" && "method" in body && typeof body.method === "string") methods.push(body.method)
    return handler.fetch(request)
  })
  t.after(async () => {
    await handler.close()
    await http.close()
  })
  const session = await remoteMcpConnector({ url: http.url, allowlist: [], reservedNames: new Set() })({ token: "member-token", signal: new AbortController().signal })
  t.after(() => session.close())

  assert.deepEqual(session.tools.map((spec) => spec.name), ["lookup"])
  assert.ok(!methods.includes("subscriptions/listen"), `no listen stream: ${methods.join(", ")}`)
})

test("a server that only speaks the 2025 protocol is still connected", async (t) => {
  const http = await listen(async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const message = await request.json() as { id?: number | string; method: string }
    const reply = (body: unknown) => Response.json({ jsonrpc: "2.0", id: message.id ?? null, ...body as object })
    if (message.id === undefined) return new Response(null, { status: 202 })
    switch (message.method) {
      case "initialize":
        return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "older", version: "1" } } })
      case "tools/list":
        return reply({ result: { tools: [tool("lookup")] } })
      case "tools/call":
        return reply({ result: { content: [{ type: "text", text: "ran lookup" }] } })
      default:
        return reply({ error: { code: -32601, message: "Method not found" } })
    }
  })
  t.after(() => http.close())
  const session = await remoteMcpConnector({ url: http.url, allowlist: [], reservedNames: new Set() })({ token: "member-token", signal: new AbortController().signal, onToolsChanged: () => {} })
  t.after(() => session.close())

  assert.deepEqual(session.tools.map((spec) => spec.name), ["lookup"])
  assert.deepEqual(await session.call("lookup", {}, new AbortController().signal), { output: "ran lookup", isError: false })
})
