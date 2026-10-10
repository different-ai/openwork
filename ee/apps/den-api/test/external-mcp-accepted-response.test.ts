import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ExternalMcpDiagnosticTracker,
  createExternalMcpDiagnosticFetch,
} from "../src/capability-sources/external-mcp-diagnostics.ts"

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

test("a 202 whose body never ends does not stall the MCP lifecycle", async () => {
  const openBodies = new Set<ServerResponse>()
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    let raw = ""
    for await (const chunk of req) raw += chunk
    const message = JSON.parse(raw)
    if (message.method === "initialize") {
      json(res, {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "accepted", version: "1" } },
      })
    } else if (message.method === "tools/list") {
      json(res, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }] } })
    } else {
      // Accept the notification but keep the response body open, as some providers do.
      res.writeHead(202, { "content-type": "application/json" })
      res.flushHeaders()
      openBodies.add(res)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  const tracker = new ExternalMcpDiagnosticTracker("test-accepted-response")
  const client = new Client({ name: "den-api-test", version: "1" })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: createExternalMcpDiagnosticFetch({ fetch, endpoint, tracker }),
    })
    const lifecycle = (async () => {
      await client.connect(transport)
      return client.listTools()
    })()
    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("MCP lifecycle stalled on the 202 response")), 5_000).unref()
    })
    const { tools } = await Promise.race([lifecycle, deadline])
    assert.deepEqual(tools.map((tool) => tool.name), ["list_meetings"])
  } finally {
    await client.close().catch(() => undefined)
    for (const res of openBodies) res.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
