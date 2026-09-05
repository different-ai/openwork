import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyStreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { expect, test } from "bun:test"
import { z } from "zod"
import {
  createAgentMcpHttpHandler,
  createScopedAgentMcpHttpHandlers,
} from "../src/mcp/agent-http.js"

type ObservedExchange = {
  body: Record<string, unknown>
  requestHeaders: Headers
  responseHeaders: Headers
}

function textFromToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0]
  if (!content || content.type !== "text") throw new Error("Expected text tool content.")
  return content.text
}

test("serves the 2026 stateless wire with fresh per-request servers", async () => {
  let serverInstances = 0
  const exchanges: ObservedExchange[] = []
  const handler = createAgentMcpHttpHandler(() => {
    const instance = ++serverInstances
    const server = new McpServer({ name: "openwork-agent-stateless-test", version: "1.0.0" })
    server.registerTool("stateless_instance", {
      description: "Return the per-request server instance ordinal.",
      inputSchema: z.object({}),
    }, async () => ({
      content: [{ type: "text", text: String(instance) }],
    }))
    return server
  })
  const transport = new StreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const body = await request.clone().json() as Record<string, unknown>
      const response = await handler.fetch(request)
      exchanges.push({
        body,
        requestHeaders: request.headers,
        responseHeaders: response.headers,
      })
      return response
    },
  })
  const client = new Client(
    { name: "stateless-wire-test", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  )

  try {
    await client.connect(transport)
    expect(client.getProtocolEra()).toBe("modern")
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28")
    expect((await client.listTools()).tools.some((tool) => tool.name === "stateless_instance")).toBe(true)

    const first = textFromToolResult(await client.callTool({ name: "stateless_instance", arguments: {} }))
    const second = textFromToolResult(await client.callTool({ name: "stateless_instance", arguments: {} }))
    expect(first).not.toBe(second)

    const methods = exchanges.map((exchange) => exchange.body.method)
    expect(methods[0]).toBe("server/discover")
    expect(methods).not.toContain("initialize")
    expect(methods).not.toContain("notifications/initialized")
    for (const exchange of exchanges) {
      const params = exchange.body.params as { _meta?: Record<string, unknown> } | undefined
      expect(params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe("2026-07-28")
      expect(params?._meta?.[CLIENT_INFO_META_KEY]).toEqual({ name: "stateless-wire-test", version: "1.0.0" })
      expect(params?._meta?.[CLIENT_CAPABILITIES_META_KEY]).toEqual({})
      expect(exchange.requestHeaders.get("mcp-protocol-version")).toBe("2026-07-28")
      expect(exchange.requestHeaders.get("mcp-method")).toBe(exchange.body.method)
      expect(exchange.requestHeaders.has("mcp-session-id")).toBe(false)
      expect(exchange.responseHeaders.has("mcp-session-id")).toBe(false)
    }
    const calls = exchanges.filter((exchange) => exchange.body.method === "tools/call")
    expect(calls).toHaveLength(2)
    expect(calls.every((exchange) => exchange.requestHeaders.get("mcp-name") === "stateless_instance")).toBe(true)
    expect(serverInstances).toBe(exchanges.length)
  } finally {
    await client.close()
    await handler.close()
  }
})

test("rejects a modern protocol header/body mismatch instead of normalizing it", async () => {
  const handler = createAgentMcpHttpHandler(() => new McpServer({
    name: "openwork-agent-stateless-test",
    version: "1.0.0",
  }))
  try {
    const response = await handler.fetch(new Request("https://openwork.example.test/mcp/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2027-01-01",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mismatched-version",
        method: "tools/list",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "stateless-wire-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }))
    const body = await response.json() as { error?: { code?: number; message?: string } }
    expect(response.status).toBe(400)
    expect(body.error?.code).toBe(-32_020)
    expect(body.error?.message).toContain("headers and body disagree")
    expect(response.headers.has("mcp-session-id")).toBe(false)
  } finally {
    await handler.close()
  }
})

test("keeps the 2025 stateless fallback for existing clients", async () => {
  const methods: string[] = []
  const handler = createAgentMcpHttpHandler(() => {
    const server = new McpServer({ name: "openwork-agent-legacy-test", version: "1.0.0" })
    server.registerTool("legacy_compatible", { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "compatible" }],
    }))
    return server
  })
  const transport = new LegacyStreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const body = await request.clone().json() as { method?: string }
      if (body.method) methods.push(body.method)
      expect(request.headers.has("mcp-session-id")).toBe(false)
      const response = await handler.fetch(request)
      expect(response.headers.has("mcp-session-id")).toBe(false)
      return response
    },
  })
  const client = new LegacyClient({ name: "legacy-stateless-test", version: "1.0.0" })

  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.some((tool) => tool.name === "legacy_compatible")).toBe(true)
    expect(methods).toContain("initialize")
    expect(methods).toContain("notifications/initialized")
    expect(methods).toContain("tools/list")
  } finally {
    await client.close()
    await handler.close()
  }
})

test("keeps a prepared request-local server bound through legacy request cloning", async () => {
  const handlers = createScopedAgentMcpHttpHandlers()
  let serverInstances = 0
  const transport = new LegacyStreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
    fetch: async (url, init) => {
      const instance = ++serverInstances
      const server = new McpServer({ name: "openwork-agent-legacy-binding-test", version: "1.0.0" })
      server.registerTool("legacy_request_instance", { inputSchema: z.object({}) }, async () => ({
        content: [{ type: "text", text: String(instance) }],
      }))
      return handlers.fetch("org-a\0user-a", new Request(url, init), server)
    },
  })
  const client = new LegacyClient({ name: "legacy-request-binding-test", version: "1.0.0" })

  try {
    await client.connect(transport)
    const result = await client.callTool({ name: "legacy_request_instance", arguments: {} })
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.any(String) })
    expect(serverInstances).toBeGreaterThan(1)
  } finally {
    await client.close()
    await handlers.close()
  }
})

test("delivers modern list changes through subscriptions/listen", async () => {
  const handler = createAgentMcpHttpHandler(() => new McpServer(
    { name: "openwork-agent-subscription-test", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  ))
  const transport = new StreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
    fetch: async (url, init) => handler.fetch(new Request(url, init)),
  })
  const client = new Client(
    { name: "stateless-subscription-test", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  )
  let toolChanges = 0
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    toolChanges += 1
  })

  try {
    await client.connect(transport)
    const subscription = await client.listen({ toolsListChanged: true })
    expect(subscription.honoredFilter).toEqual({ toolsListChanged: true })
    handler.notify.toolsChanged()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toolChanges).toBe(1)
    await subscription.close()
  } finally {
    await client.close()
    await handler.close()
  }
})

test("isolates list-change subscriptions by authenticated catalog audience", async () => {
  const handlers = createScopedAgentMcpHttpHandlers()
  const requestServer = (toolName: string) => {
    const server = new McpServer(
      { name: "openwork-agent-scoped-subscription-test", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
    )
    server.registerTool(toolName, { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: toolName }],
    }))
    return server
  }
  const clientFor = (scopeKey: string, toolName: string) => {
    const transport = new StreamableHTTPClientTransport(new URL("https://openwork.example.test/mcp/agent"), {
      fetch: async (url, init) => handlers.fetch(scopeKey, new Request(url, init), requestServer(toolName)),
    })
    const client = new Client(
      { name: `stateless-scoped-subscription-${scopeKey}`, version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    )
    return { client, transport }
  }
  const first = clientFor("org-a\0user-a", "scope_a_tool")
  const second = clientFor("org-b\0user-b", "scope_b_tool")
  const firstChanges = { tools: 0, resources: 0 }
  const secondChanges = { tools: 0, resources: 0 }
  first.client.setNotificationHandler("notifications/tools/list_changed", () => {
    firstChanges.tools += 1
  })
  first.client.setNotificationHandler("notifications/resources/list_changed", () => {
    firstChanges.resources += 1
  })
  second.client.setNotificationHandler("notifications/tools/list_changed", () => {
    secondChanges.tools += 1
  })
  second.client.setNotificationHandler("notifications/resources/list_changed", () => {
    secondChanges.resources += 1
  })

  try {
    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ])
    const [firstTools, secondTools] = await Promise.all([
      first.client.listTools(),
      second.client.listTools(),
    ])
    expect(firstTools.tools.map((tool) => tool.name)).toEqual(["scope_a_tool"])
    expect(secondTools.tools.map((tool) => tool.name)).toEqual(["scope_b_tool"])
    const [firstSubscription, secondSubscription] = await Promise.all([
      first.client.listen({ toolsListChanged: true, resourcesListChanged: true }),
      second.client.listen({ toolsListChanged: true, resourcesListChanged: true }),
    ])
    try {
      handlers.notify.toolsChanged("org-a\0user-a")
      handlers.notify.resourcesChanged("org-a\0user-a")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(firstChanges).toEqual({ tools: 1, resources: 1 })
      expect(secondChanges).toEqual({ tools: 0, resources: 0 })

      handlers.notify.toolsChanged("org-b\0user-b")
      handlers.notify.resourcesChanged("org-b\0user-b")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(firstChanges).toEqual({ tools: 1, resources: 1 })
      expect(secondChanges).toEqual({ tools: 1, resources: 1 })
    } finally {
      await Promise.all([firstSubscription.close(), secondSubscription.close()])
    }
  } finally {
    await Promise.all([first.client.close(), second.client.close()])
    await handlers.close()
  }
})
