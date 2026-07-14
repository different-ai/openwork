import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import {
  createConnectMcpServer,
  createConnectRuntime,
  registerConnectTools,
  type ConnectCapabilitySource,
} from "../src/index.js"

function source(input: {
  id: string
  score: number
  type?: "mcp" | "skills"
  name?: string
}): ConnectCapabilitySource {
  const name = input.name ?? `${input.id}:search`
  return {
    id: input.id,
    types: [input.type ?? "mcp"],
    search: ({ query }) => ({
      matches: [{
        name,
        method: "MCP",
        path: `connect://${input.id}`,
        score: input.score,
        summary: `${input.id} handles ${query}`,
        pathParams: [],
        queryParams: [],
        hasBody: true,
      }],
    }),
    canExecute: (candidate) => candidate === name,
    execute: async ({ body }) => ({
      content: [{ type: "text", text: JSON.stringify({ source: input.id, body }) }],
    }),
  }
}

test("runtime merges, ranks, filters, and bounds package-defined sources", async () => {
  const runtime = createConnectRuntime({
    sources: [source({ id: "alpha", score: 2 }), source({ id: "beta", score: 8, type: "skills" })],
  })

  assert.deepEqual((await runtime.search({ query: "search" })).matches.map((match) => match.name), [
    "beta:search",
    "alpha:search",
  ])
  assert.deepEqual((await runtime.search({ query: "search", type: "skills" })).matches.map((match) => match.name), [
    "beta:search",
  ])
})

test("runtime rejects missing and ambiguous capability ownership", async () => {
  const runtime = createConnectRuntime({
    sources: [
      source({ id: "alpha", score: 1, name: "shared" }),
      source({ id: "beta", score: 2, name: "shared" }),
    ],
  })

  assert.equal(JSON.parse((await runtime.execute({ name: "missing" })).content[0]?.text ?? "{}").error, "unknown_capability")
  const ambiguous = await runtime.execute({ name: "shared" })
  assert.equal(ambiguous.isError, true)
  assert.deepEqual(JSON.parse(ambiguous.content[0]?.text ?? "{}").sources, ["alpha", "beta"])
})

class MemoryTransport implements Transport {
  private peer: MemoryTransport | undefined
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: (<T extends JSONRPCMessage>(message: T) => void) | undefined

  connectPeer(peer: MemoryTransport) {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.peer?.onmessage?.(message)
  }

  async close(): Promise<void> {
    this.onclose?.()
  }
}

test("MCP adapter exposes the same fixed two-tool surface for every host", async () => {
  const runtime = createConnectRuntime({ sources: [source({ id: "alpha", score: 4 })] })
  const server = createConnectMcpServer({ instructions: "portable Connect test" })
  registerConnectTools(server, runtime)
  const client = new Client({ name: "connect-core-test", version: "1.0.0" })
  const clientTransport = new MemoryTransport()
  const serverTransport = new MemoryTransport()
  clientTransport.connectPeer(serverTransport)
  serverTransport.connectPeer(clientTransport)

  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const tools = await client.listTools()

  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["execute_capability", "search_capabilities"])
  assert.equal(client.getInstructions(), "portable Connect test")

  await client.close()
  await server.close()
})
