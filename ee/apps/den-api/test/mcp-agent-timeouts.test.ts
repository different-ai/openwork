import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import { beforeAll, expect, test } from "bun:test"
import type { ExecuteCapabilityToolResult } from "../src/mcp/agent.js"
import { compareCapabilityMatches, type CapabilityMatch } from "../src/mcp/search.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

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

function createMemoryTransportPair() {
  const client = new MemoryTransport()
  const server = new MemoryTransport()
  client.connectPeer(server)
  server.connectPeer(client)
  return { client, server }
}

let agentModule: typeof import("../src/mcp/agent.js")

beforeAll(async () => {
  seedRequiredEnv()
  agentModule = await import("../src/mcp/agent.js")
})

test("executeCapabilityWithBudget returns a structured timeout result", async () => {
  const result = await agentModule.executeCapabilityWithBudget({
    capability: "gmail_search",
    timeoutMs: 1,
    invoke: () => new Promise<ExecuteCapabilityToolResult>(() => {}),
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).toBe(JSON.stringify({
    error: "capability_timeout",
    capability: "gmail_search",
    message: "The capability call exceeded 45s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.",
  }))
})

test("executeCapabilityWithBudget swallows late rejections after timeout", async () => {
  const unhandled: unknown[] = []
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandledRejection)

  try {
    const result = await agentModule.executeCapabilityWithBudget({
      capability: "slow_google_workspace",
      timeoutMs: 1,
      invoke: () => new Promise<ExecuteCapabilityToolResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late capability failure")), 10)
      }),
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(JSON.stringify({
      error: "capability_timeout",
      capability: "slow_google_workspace",
      message: "The capability call exceeded 45s. Retry once; if it times out again, narrow the request (fewer results, tighter query) and tell the user the service is slow — do NOT tell them to reconfigure or reconnect.",
    }))

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
  }
})

test("agent MCP server exposes steering instructions during initialize", async () => {
  const server = agentModule.createAgentMcpServer()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  const transports = createMemoryTransportPair()

  await server.connect(transports.server)
  await client.connect(transports.client)

  expect(client.getInstructions()).toBe(agentModule.AGENT_MCP_INSTRUCTIONS)
  expect(client.getInstructions()).toContain("search_capabilities and execute_capability")
  expect(client.getInstructions()).toContain("Gmail read/search")
  expect(client.getInstructions()).toContain("Settings > Connect")
  expect(client.getInstructions()).toContain("Never tell the user to reconnect OpenWork Cloud")
  expect(client.getInstructions()).toContain("connectionStatus.connectionName")

  await client.close()
  await server.close()
})

test("capability search results include structured output alongside text compatibility", () => {
  const matches = [{
    name: "getOrganizations",
    method: "GET",
    path: "/v1/organizations",
    score: 10,
    summary: "List organizations",
    pathParams: [],
    queryParams: [],
    hasBody: false,
  }]
  const result = agentModule.capabilitySearchToolResult(matches)

  expect(result.structuredContent).toEqual({ matches })
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({ matches })
})

test("capability search preserves the bounded-fanout coverage warning", () => {
  const result = agentModule.capabilitySearchToolResult([], "External MCP search inspected 16 of 17 eligible connections. Results may be incomplete.")
  const structured = result.structuredContent

  expect(structured).toEqual({
    matches: [],
    hint: "No matches. Try broader or different keywords. External MCP search inspected 16 of 17 eligible connections. Results may be incomplete.",
  })
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(structured)
})

test("external capability failures preserve the safe MCP diagnostic envelope", () => {
  const result = agentModule.externalCapabilityErrorToolResult({
    ok: false,
    error: "connection_failed",
    message: "Connection failed. Diagnostic reference: req_test.",
    actionOwner: "network_admin",
    operatorAction: "Repair the certificate chain.",
    diagnostic: {
      referenceId: "req_test",
      phase: "NETWORK_TLS",
      category: "tls_failure",
      code: "MCP_CERT_HAS_EXPIRED",
      highestPassed: "reachable",
      retryable: false,
      actionOwner: "network_admin",
      operatorAction: "Repair the certificate chain.",
      message: "TLS validation failed.",
    },
  })
  expect(result.isError).toBe(true)
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
    error: "connection_failed",
    actionOwner: "network_admin",
    operatorAction: "Repair the certificate chain.",
    diagnostic: {
      referenceId: "req_test",
      phase: "NETWORK_TLS",
      actionOwner: "network_admin",
    },
  })
})

test("structured search output remains compatible with marketplace match kinds and statuses", () => {
  const result = agentModule.SEARCH_CAPABILITIES_OUTPUT_SCHEMA.safeParse({
    matches: [{
      name: "marketplace:plugin:skill",
      method: "MARKETPLACE",
      path: "marketplace://plugin/skill",
      score: 8,
      summary: "Install a shared skill",
      pathParams: [],
      queryParams: [],
      hasBody: false,
      kind: "skill",
      status: "needs_install",
    }],
  })

  expect(result.success).toBe(true)
})

test("capability discovery is marked read-only while generic execution remains guarded", () => {
  expect(agentModule.SEARCH_CAPABILITIES_ANNOTATIONS).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  })
  expect(agentModule.EXECUTE_CAPABILITY_ANNOTATIONS).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  })
})

test("connection status ranks above unrelated callable tools without distorting relevance scores", () => {
  type ConnectionStatusMatch = CapabilityMatch & { kind: "connection_status" }
  const callableMatch: CapabilityMatch = {
    name: "slack_search_emojis",
    method: "MCP",
    path: "https://mcp.slack.test",
    score: 20,
    summary: "Search custom emoji",
    pathParams: [],
    queryParams: [],
    hasBody: true,
  }
  const statusMatch: ConnectionStatusMatch = {
    kind: "connection_status",
    name: "mcp:notion:*",
    method: "MCP",
    path: "https://mcp.notion.test",
    score: 7,
    summary: "Notion needs attention",
    pathParams: [],
    queryParams: [],
    hasBody: false,
  }
  const matches: CapabilityMatch[] = [callableMatch, statusMatch]

  matches.sort(compareCapabilityMatches)

  expect(matches[0]?.kind).toBe("connection_status")
  expect(matches[0]?.score).toBe(7)
})
