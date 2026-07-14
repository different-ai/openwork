import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import {
  createConnectMcpServer,
  createConnectRuntime,
  createRemoteMcpCapabilitySource,
  CONNECT_AGENT_PATH,
  CONNECT_CONTRACT_VERSION,
  CONNECT_MCP_ALIAS,
  CONNECT_RUNTIME_VERSION,
  parseRemoteMcpCapabilityName,
  registerConnectTools,
  type ConnectCapabilitySource,
} from "../src/index.js"

test("package manifest matches the public portable runtime contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../connect-runtime.manifest.json", import.meta.url), "utf8"))
  assert.equal(manifest.runtimeVersion, CONNECT_RUNTIME_VERSION)
  assert.equal(manifest.contractVersion, CONNECT_CONTRACT_VERSION)
  assert.equal(manifest.mcpAlias, CONNECT_MCP_ALIAS)
  assert.equal(manifest.agentPath, CONNECT_AGENT_PATH)
  assert.deepEqual([...manifest.tools].sort(), ["execute_capability", "search_capabilities"])
})

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

test("runtime isolates failed and timed-out sources with an incomplete coverage hint", async () => {
  const failed = source({ id: "failed", score: 1 })
  failed.search = async () => { throw new Error("secret provider response") }
  const stalled = source({ id: "stalled", score: 1 })
  stalled.search = () => new Promise(() => undefined)
  const runtime = createConnectRuntime({
    sources: [source({ id: "ready", score: 5 }), failed, stalled],
    searchSourceTimeoutMs: 5,
  })

  const result = await runtime.search({ query: "search" })
  assert.deepEqual(result.matches.map((match) => match.name), ["ready:search"])
  assert.match(result.hint ?? "", /failed/)
  assert.match(result.hint ?? "", /stalled/)
  assert.doesNotMatch(result.hint ?? "", /secret provider response/)
})

test("runtime truncates search results at the serialized response budget", async () => {
  const large = source({ id: "large", score: 10 })
  large.search = () => ({
    matches: [{
      name: "large:search",
      method: "MCP",
      path: "connect://large",
      score: 10,
      summary: "x".repeat(1_000),
      pathParams: [],
      queryParams: [],
      hasBody: true,
    }],
  })
  const runtime = createConnectRuntime({ sources: [large], searchResultMaxBytes: 256 })
  const result = await runtime.search({ query: "search" })

  assert.deepEqual(result.matches, [])
  assert.match(result.hint ?? "", /serialized response limit/)
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

test("runtime rejects oversized capability results", async () => {
  const runtime = createConnectRuntime({
    sources: [source({ id: "large", score: 1 })],
    executeResultMaxBytes: 128,
  })
  const result = await runtime.execute({ name: "large:search", body: { value: "x".repeat(1_000) } })

  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0]?.text ?? "{}").error, "capability_result_too_large")
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

test("remote MCP source namespaces discovery and exact execution consistently", async () => {
  const remote = createRemoteMcpCapabilitySource({
    listConnections: async () => [{
      id: "notion",
      name: "Notion",
      serverUrl: "https://mcp.notion.example",
      status: "connected",
    }],
    listTools: async () => [{ name: "search_pages", description: "Search workspace pages" }],
    callTool: async ({ connection, toolName, arguments: args }) => ({
      content: [{ type: "text", text: JSON.stringify({ connection: connection.id, toolName, args }) }],
    }),
  })
  const runtime = createConnectRuntime({ sources: [remote] })
  const search = await runtime.search({ query: "search notion" })

  assert.equal(search.matches[0]?.name, "mcp:notion:search_pages")
  assert.deepEqual(parseRemoteMcpCapabilityName(search.matches[0]?.name ?? ""), {
    connectionId: "notion",
    toolName: "search_pages",
  })
  assert.deepEqual(JSON.parse((await runtime.execute({
    name: "mcp:notion:search_pages",
    body: { query: "roadmap" },
  })).content[0]?.text ?? "{}"), {
    connection: "notion",
    toolName: "search_pages",
    args: { query: "roadmap" },
  })
})
