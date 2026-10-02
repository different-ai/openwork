import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { expect, mock, test } from "bun:test"

process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3005"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"

// The proxy module reaches ./auth.js -> ../auth.js, whose better-auth instance
// seeds the oauthResource registry against the database at import time. This
// suite never verifies a bearer token, so stand in for that module the same way
// test/mcp-membership-revocation.test.ts does and keep the run hermetic.
mock.module("../src/auth.js", () => ({
  auth: {
    handler: () => Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
  },
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: [
    "http://127.0.0.1:8790/mcp",
    "http://127.0.0.1:8790/mcp/agent",
    "http://127.0.0.1:8790/mcp/admin",
  ],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

const {
  createExternalConnectionProxyServer,
  handleExternalConnectionProxyRequest,
} = await import("../src/mcp/external-connection-proxy.js")
const {
  externalMcpConnectionReadyForMember,
  readyExternalMcpConnectionsForMember,
} = await import("../src/capability-sources/external-mcp-connections.js")
const { ExternalMcpDiagnosticError } = await import("../src/capability-sources/external-mcp-diagnostics.js")
const { buildConnectMcpServerIndex, connectMcpServerIndexAppCapacity, selectConnectMcpServerIndexConnections } = await import("../src/mcp/connect-mcp-server-index.js")

const resourceUri = "ui://fixture/healthy.html"
const html = "<!doctype html><html><body>Healthy native MCP App</body></html>"
const connection = {
  id: "emc_01k28e8q8pf8r9sff9mhyqxved",
  organizationId: "org_01k28e8q8pf8r9sff9mhyqxved",
  name: "Fixture MCP",
  authType: "none",
  credentialMode: "shared",
  kind: "external_mcp",
  toolPolicy: null,
  exposeDirectly: false,
  oauthIssuerReviewRequiredAt: null,
} as never
const directConnection = { ...(connection as Record<string, unknown>), exposeDirectly: true } as never
const operation = {
  connection,
  redirectUri: "https://openwork.example/v1/mcp-connections/fixture/connect/callback",
  member: { orgMembershipId: "mem_01k28e8q8pf8r9sff9mhyqxved" },
  diagnosticReferenceId: "req_proxy_fixture",
} as never

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    listTools: async () => [{
      name: "open_fixture",
      description: "Open the fixture App.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
    }],
    callTool: async () => ({
      content: [{ type: "text" as const, text: "Healthy fixture opened." }],
      structuredContent: { status: "healthy" },
    }),
    listResources: async () => [{ uri: resourceUri, name: "Healthy fixture", mimeType: "text/html;profile=mcp-app" }],
    listResourceTemplates: async () => [],
    readResource: async () => ({
      contents: [{ uri: resourceUri, mimeType: "text/html;profile=mcp-app", text: html }],
    }),
    ...overrides,
  } as never
}

function requestContext(request: Request) {
  return { req: { method: request.method, raw: request } } as never
}

async function withClient<T>(
  capabilities: Record<string, unknown>,
  run: (client: Client) => Promise<T>,
  runtimeOverrides: Record<string, unknown> = {},
  appHostClient = true,
  proxiedConnection: unknown = connection,
  directExposureEnabled = true,
  scopes = new Set(["mcp:read", "mcp:write"]),
) {
  const server = createExternalConnectionProxyServer({
    scopes,
    descriptor: {
      capabilities,
      serverInfo: { name: "fixture", version: "1.0.0" },
    } as never,
    operation: { ...(operation as Record<string, unknown>), connection: proxiedConnection } as never,
    runtime: runtime(runtimeOverrides),
    appHostClient,
    directExposureEnabled,
  })
  const client = new Client({ name: "proxy-test", version: "1.0.0" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("ordinary MCP clients receive only bounded search and execute without the per-provider App surface", async () => {
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
    ])
    expect((await client.listResources()).resources).toEqual([])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    const searched = await client.callTool({ name: "search_capabilities", arguments: { query: "fixture" } })
    const matches = (searched.structuredContent as { matches: Array<Record<string, unknown>> }).matches
    expect(matches).toContainEqual(expect.objectContaining({ name: "open_fixture" }))
    expect(matches[0]?.kind).toBeUndefined()
    expect(matches[0]?.mcpApp).toBeUndefined()
    expect((await client.callTool({ name: "execute_capability", arguments: { name: "open_fixture", body: {} } })).structuredContent)
      .toEqual({ status: "healthy" })
    await expect(client.callTool({ name: "open_fixture", arguments: {} }))
      .rejects.toThrow("Use search_capabilities and execute_capability")
    await expect(client.readResource({ uri: resourceUri }))
      .rejects.toThrow("require direct exposure or the OpenWork App host")
  }, {}, false)
})

test("legacy clients retain ordinary operations through bounded search and execute only", async () => {
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
    ])
    expect((await client.listResources()).resources).toEqual([])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    const searched = await client.callTool({ name: "search_capabilities", arguments: { query: "ordinary records" } })
    expect((searched.structuredContent as { matches: Array<Record<string, unknown>> }).matches).toEqual([
      expect.objectContaining({ name: "search_fixture" }),
    ])
    expect((await client.callTool({
      name: "execute_capability",
      arguments: { name: "search_fixture", body: { query: "ordinary" } },
    })).structuredContent).toEqual({ status: "healthy" })
    await expect(client.callTool({ name: "search_fixture", arguments: { query: "ordinary" } }))
      .rejects.toThrow("Use search_capabilities and execute_capability")
    await expect(client.readResource({ uri: resourceUri }))
      .rejects.toThrow("require direct exposure or the OpenWork App host")
  }, {
    listTools: async () => [{
      name: "search_fixture",
      description: "Search ordinary fixture records.",
      inputSchema: { type: "object" },
    }],
  }, false)
})

test("a directly exposed connection serves its provider catalog to ordinary clients", async () => {
  let downstreamCalls = 0
  let downstreamCalledWith: unknown = null
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "open_fixture",
      "search_fixture",
    ])
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([resourceUri])
    const called = await client.callTool({ name: "search_fixture", arguments: { query: "direct" } })
    expect(called.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(1)
    expect(downstreamCalledWith).toMatchObject({ toolName: "search_fixture", args: { query: "direct" } })
    await expect(client.callTool({ name: "app_only_fixture", arguments: {} })).rejects.toThrow("is not available on Fixture MCP")
    await expect(client.callTool({ name: "blocked_fixture", arguments: {} })).rejects.toThrow("is not available on Fixture MCP")
    await expect(client.callTool({ name: "search_capabilities", arguments: { query: "direct" } })).rejects.toThrow("is not available on Fixture MCP")
    expect((await client.readResource({ uri: resourceUri })).contents[0]).toMatchObject({ uri: resourceUri, text: html })
    expect(downstreamCalls).toBe(1)
  }, {
    listTools: async () => [
      ...(await runtime().listTools()),
      { name: "search_fixture", description: "Search fixture records.", inputSchema: { type: "object" } },
      {
        name: "app_only_fixture",
        description: "An App-only tool that stays private to the App host.",
        inputSchema: { type: "object" },
        _meta: { ui: { resourceUri, visibility: ["app"] } },
      },
      { name: "blocked_fixture", description: "Blocked by the organization tool policy.", inputSchema: { type: "object" } },
    ],
    callTool: async (input: { toolName: string; args: unknown }) => {
      downstreamCalls += 1
      downstreamCalledWith = input
      return {
        content: [{ type: "text" as const, text: "Direct fixture call." }],
        structuredContent: { status: "healthy" },
      }
    },
  }, false, {
    ...(directConnection as Record<string, unknown>),
    toolPolicy: { allDisabled: false, disabledTools: ["blocked_fixture"] },
  })
})

test.each([{ visibility: undefined }, { visibility: ["model"] }, { visibility: ["model", "app"] }])("direct MCP App resources follow model-visible launch tools and live policy: %j", async ({ visibility }) => {
  const privateUri = "ui://fixture/private.html"
  const unrelatedUri = "ui://fixture/unrelated.html"
  const ui = { resourceUri, ...(visibility ? { visibility } : {}) }
  const resource = {
    uri: resourceUri,
    name: "Fixture App",
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { csp: { connectDomains: ["https://fixture.example"], resourceDomains: [] } } },
  }
  const contents = [{ uri: resourceUri, mimeType: resource.mimeType, _meta: resource._meta, text: html }]
  const launchResult = {
    content: [{ type: "text", text: "Fixture opened." }],
    structuredContent: { status: "healthy" },
    _meta: { fixture: "preserved" },
  }
  const toolPolicy: { allDisabled: boolean; disabledTools: string[] } = { allDisabled: false, disabledTools: [] }
  const reads: unknown[] = []
  const calls: unknown[] = []
  await withClient({
    tools: {}, resources: {},
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [resource.mimeType] } },
  }, async (client) => {
    expect(client.getServerCapabilities()?.extensions).toEqual({ "io.modelcontextprotocol/ui": { mimeTypes: [resource.mimeType] } })
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual(["open_fixture"])
    expect(tools[0]?._meta).toEqual({ ui })
    expect(await client.callTool({ name: "open_fixture", arguments: {} })).toEqual(launchResult)
    expect(calls).toHaveLength(1)
    expect((await client.listResources()).resources).toEqual([resource])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])
    expect(await client.readResource({ uri: resourceUri })).toEqual({ contents })
    expect(reads).toEqual([expect.objectContaining({ connection: expect.objectContaining({ exposeDirectly: true }), member: operation.member, uri: resourceUri })])
    for (const uri of [privateUri, unrelatedUri]) {
      await expect(client.readResource({ uri })).rejects.toThrow("not bound to an available MCP App tool")
    }
    await expect(client.callTool({ name: "private_helper", arguments: {} })).rejects.toThrow("is not available on Fixture MCP")
    expect(calls).toHaveLength(1)
    for (const allDisabled of [false, true]) {
      toolPolicy.allDisabled = allDisabled
      toolPolicy.disabledTools = allDisabled ? [] : ["open_fixture"]
      expect((await client.listTools()).tools).toEqual([])
      expect((await client.listResources()).resources).toEqual([])
      await expect(client.readResource({ uri: resourceUri })).rejects.toThrow("not bound to an available MCP App tool")
    }
    expect(reads).toHaveLength(1)
  }, {
    listTools: async () => [
      { name: "open_fixture", inputSchema: { type: "object" }, _meta: { ui } },
      { name: "private_helper", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: privateUri, visibility: ["app"] } } },
    ],
    listResources: async () => [resource, { ...resource, uri: privateUri }, { ...resource, uri: unrelatedUri }],
    readResource: async (input: unknown) => { reads.push(input); return { contents } },
    callTool: async (input: unknown) => { calls.push(input); return launchResult },
  }, false, { ...connection, exposeDirectly: true, toolPolicy }, true, new Set(["mcp:read", "mcp:write"]))
})

test("direct exposure stays closed while the organization has member-facing MCP connections disabled", async () => {
  let downstreamCalls = 0
  let resourceCalls = 0
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
    ])
    await expect(client.callTool({ name: "open_fixture", arguments: {} }))
      .rejects.toThrow("Use search_capabilities and execute_capability")
    expect((await client.listResources()).resources).toEqual([])
    await expect(client.readResource({ uri: resourceUri })).rejects.toThrow("require direct exposure or the OpenWork App host")
    expect(downstreamCalls).toBe(0)
    expect(resourceCalls).toBe(0)
  }, {
    callTool: async () => {
      downstreamCalls += 1
      return { content: [], structuredContent: {} }
    },
    listResources: async () => { resourceCalls += 1; return [] },
    readResource: async () => { resourceCalls += 1; return { contents: [] } },
  }, false, directConnection, false)
})

test.each(["direct", "compatibility", "app", "app-compatibility"])("%s execution requires write scope even for misleading read-only hints", async (mode) => {
  const cases: Array<{ annotations?: Tool["annotations"]; requiredScope: string }> = [
    { requiredScope: "mcp:write" },
    { annotations: {}, requiredScope: "mcp:write" },
    { annotations: { readOnlyHint: false }, requiredScope: "mcp:write" },
    { annotations: { destructiveHint: false, idempotentHint: true }, requiredScope: "mcp:write" },
    { annotations: { readOnlyHint: true, destructiveHint: true }, requiredScope: "mcp:write" },
    { annotations: { readOnlyHint: true }, requiredScope: "mcp:write" },
    { annotations: { readOnlyHint: true, destructiveHint: false }, requiredScope: "mcp:write" },
  ]
  for (const scopes of [new Set(["mcp:read"]), new Set(["mcp:read", "mcp:write"]), new Set(["mcp:write"]), new Set(["mcp:app-host"])]) {
    let downstreamCalls = 0
    let liveTool: Tool | undefined = {
      name: "scope_fixture",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
    }
    await withClient({ tools: {} }, async (client) => {
      await client.listTools()
      const call = () => client.callTool(mode.endsWith("compatibility")
        ? { name: "execute_capability", arguments: { name: "scope_fixture", body: { marker: "scoped" } } }
        : { name: "scope_fixture", arguments: { marker: "scoped" } })
      for (const entry of cases) {
        if (!liveTool) throw new Error("Missing fixture descriptor")
        liveTool = { ...liveTool, annotations: entry.annotations }
        const before = downstreamCalls
        const result = await call()
        if (scopes.has(entry.requiredScope)) {
          expect(result.isError).not.toBe(true)
          expect(result.structuredContent).toEqual({ marker: "scoped" })
          expect(downstreamCalls).toBe(before + 1)
        } else {
          expect(result.isError).toBe(true)
          expect(result.content).toEqual([{ type: "text", text: JSON.stringify({
            error: "insufficient_mcp_scope",
            requiredScope: entry.requiredScope,
            message: `scope_fixture requires the ${entry.requiredScope} scope.`,
          }) }])
          expect(downstreamCalls).toBe(before)
        }
      }
      liveTool = undefined
      const before = downstreamCalls
      await expect(call()).rejects.toThrow()
      expect(downstreamCalls).toBe(before)
    }, {
      listTools: async () => liveTool ? [liveTool] : [],
      callTool: async (input: { args: Record<string, unknown> }) => {
        downstreamCalls += 1
        return { content: [], structuredContent: input.args }
      },
    }, mode.startsWith("app"), mode === "direct" ? directConnection : connection, true, scopes)
  }
})

test("the request handler never enables direct exposure unless the route confirms the organization flag", async () => {
  let toolNames: string[] = []
  const request = new Request("https://openwork.example/mcp/agent/connections/fixture", { method: "POST" })
  await handleExternalConnectionProxyRequest({
    scopes: new Set(["mcp:read", "mcp:write"]),
    context: requestContext(request),
    operation: { ...(operation as Record<string, unknown>), connection: directConnection } as never,
    runtime: runtime(),
    dependencies: {
      describe: async () => ({
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      }) as never,
      serve: async (server) => {
        const client = new Client({ name: "default-gate-test", version: "1.0.0" }, { capabilities: {} })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        try {
          toolNames = (await client.listTools()).tools.map((tool) => tool.name)
        } finally {
          await client.close()
          await server.close()
        }
        return new Response(null, { status: 204 })
      },
    },
  })
  expect(toolNames).toEqual(["search_capabilities", "execute_capability"])
})

test("direct exposure does not change the App host surface", async () => {
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect(client.getInstructions()).not.toContain("Fixture MCP")
    expect(client.getInstructions()).toContain("Omitted UI visibility defaults to model and app")
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
      "open_fixture",
    ])
    for (const tool of (await client.listTools()).tools) expect(tool._meta).toMatchObject({ ui: { visibility: ["app"] } })
  }, {}, true, directConnection)
})

test("a forged App-host audience header cannot unlock the provider surface", async () => {
  let toolNames: string[] = []
  const request = new Request("https://openwork.example/mcp/agent/connections/fixture", {
    method: "POST",
    headers: { "x-openwork-mcp-client-audience": "app-host" },
  })
  await handleExternalConnectionProxyRequest({
    scopes: new Set(["mcp:read", "mcp:write"]),
    context: requestContext(request),
    operation,
    runtime: runtime(),
    dependencies: {
      describe: async () => ({
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      }) as never,
      serve: async (server) => {
        const client = new Client({ name: "forged-audience-test", version: "1.0.0" }, { capabilities: {} })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        try {
          toolNames = (await client.listTools()).tools.map((tool) => tool.name)
        } finally {
          await client.close()
          await server.close()
        }
        return new Response(null, { status: 204 })
      },
    },
  })
  expect(toolNames).toEqual(["search_capabilities", "execute_capability"])
})

test("tool-only downstream servers initialize and never register resource handlers", async () => {
  let resourceCalls = 0
  await withClient({ tools: {} }, async (client) => {
    const initialized = client.getServerCapabilities()
    expect(initialized?.tools).toEqual({ listChanged: false })
    expect(initialized?.resources).toBeUndefined()
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
      "open_fixture",
    ])
    const called = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(called.structuredContent).toEqual({ status: "healthy" })
    expect(resourceCalls).toBe(0)
  }, {
    listResources: async () => { resourceCalls += 1; return [] },
    listResourceTemplates: async () => { resourceCalls += 1; return [] },
    readResource: async () => { resourceCalls += 1; return { contents: [] } },
  })
})

test("a downstream server without resources initializes safely", async () => {
  await withClient({}, async (client) => {
    expect(client.getServerCapabilities()?.resources).toBeUndefined()
    expect(client.getServerCapabilities()?.tools).toBeUndefined()
  })
})

test("a healthy native MCP App preserves its resource and same-server app-visible tool", async () => {
  await withClient({
    tools: {},
    resources: {},
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  }, async (client) => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "open_fixture")
    expect(tool?._meta).toMatchObject({ ui: { resourceUri, visibility: ["app"] } })
    const resource = await client.readResource({ uri: resourceUri })
    expect(resource.contents[0]).toMatchObject({ uri: resourceUri, text: html })
    const called = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(called.structuredContent).toEqual({ status: "healthy" })
  })
})

test.each(["explicit", "omitted"])("%s app visibility permits unbound helpers only on their connection and preserves ordinary catalogs", async (visibility) => {
  const helper: Tool = {
    name: "update_fixture_draft",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    ...(visibility === "explicit" ? { _meta: { ui: { visibility: ["app"] } } } : {}),
  }
  const calls: unknown[] = []
  let reads = 0
  const overrides = {
    listTools: async () => [helper],
    callTool: async (input: unknown) => {
      calls.push(input)
      return { content: [], structuredContent: { updated: true } }
    },
    readResource: async () => { reads += 1; return { contents: [] } },
  }
  await withClient({ tools: {}, resources: {} }, async (client) => {
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual(["search_capabilities", "execute_capability", helper.name])
    expect(tools[2]).toEqual({ ...helper, _meta: { ui: { visibility: ["app"] } } })
    expect((await client.listResources()).resources).toEqual([])
    await expect(client.readResource({ uri: resourceUri })).rejects.toThrow("not bound to an available MCP App tool")
    await expect(client.callTool({ name: "unknown_fixture", arguments: {} })).rejects.toThrow("not available on the MCP Apps endpoint")
    expect(calls).toHaveLength(0)
    expect(reads).toBe(0)
    expect((await client.callTool({ name: helper.name, arguments: { text: "updated" } })).structuredContent).toEqual({ updated: true })
    expect(calls).toEqual([expect.objectContaining({ connection, member: operation.member, toolName: helper.name, args: { text: "updated" } })])
  }, overrides)
  await withClient({ tools: {} }, async (client) => {
    await expect(client.callTool({ name: helper.name, arguments: {} })).rejects.toThrow("not available on the MCP Apps endpoint")
  }, { ...overrides, listTools: async () => [] }, true, { ...connection, id: "emc_other_fixture" })
  expect(calls).toHaveLength(1)
  for (const proxiedConnection of [connection, directConnection]) {
    await withClient({ tools: {} }, async (client) => {
      const tools = (await client.listTools()).tools
      const directlyAvailable = proxiedConnection === directConnection && visibility === "omitted"
      expect(tools.map((tool) => tool.name)).toEqual(proxiedConnection === connection
        ? ["search_capabilities", "execute_capability"] : directlyAvailable ? [helper.name] : [])
      if (directlyAvailable) {
        expect(tools[0]).toEqual(helper)
        expect((await client.callTool({ name: helper.name, arguments: { text: "ordinary" } })).structuredContent).toEqual({ updated: true })
      } else {
        await expect(client.callTool({ name: helper.name, arguments: {} })).rejects.toThrow()
      }
    }, overrides, false, proxiedConnection)
  }
  expect(calls).toHaveLength(visibility === "omitted" ? 2 : 1)
})

test.each([
  { visibility: undefined, allowed: true },
  { visibility: null, allowed: false },
  { visibility: [], allowed: false },
  { visibility: ["model"], allowed: false },
  { visibility: "app", allowed: false },
  { visibility: ["app", "unknown"], allowed: false },
  { visibility: ["app"], allowed: true },
  { visibility: ["model", "app"], allowed: true },
])("unbound helper defaults to app visibility but rejects explicit exclusions or malformed visibility: %j", async ({ visibility, allowed }) => {
  const helper: Tool = {
    name: "resolve_fixture_recipient",
    inputSchema: { type: "object" },
    _meta: { ui: visibility === undefined ? {} : { visibility } },
  }
  let calls = 0
  await withClient({ tools: {}, resources: {} }, async (client) => {
    const tools = (await client.listTools()).tools
    expect(tools.some(tool => tool.name === helper.name)).toBe(allowed)
    expect((await client.listResources()).resources).toEqual([])
    if (allowed) {
      expect(tools.find(tool => tool.name === helper.name)?._meta).toEqual({ ui: { visibility: ["app"] } })
      expect(await client.callTool({ name: helper.name, arguments: {} })).toMatchObject({ structuredContent: { resolved: true } })
    } else {
      await expect(client.callTool({ name: helper.name, arguments: {} })).rejects.toThrow("not available on the MCP Apps endpoint")
    }
  }, {
    listTools: async () => [helper],
    callTool: async () => { calls += 1; return { content: [], structuredContent: { resolved: true } } },
  })
  expect(calls).toBe(allowed ? 1 : 0)
})

test.each(["explicit", "omitted"])("unbound App helpers with %s visibility retain write scope and live tool policy enforcement", async (visibility) => {
  const helper: Tool = {
    name: "update_fixture_draft",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false },
    ...(visibility === "explicit" ? { _meta: { ui: { visibility: ["app"] } } } : {}),
  }
  let calls = 0
  const toolPolicy: { allDisabled: boolean; disabledTools: string[] } = { allDisabled: false, disabledTools: [] }
  const overrides = {
    listTools: async () => [helper],
    callTool: async () => { calls += 1; return { content: [] } },
  }
  await withClient({ tools: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(helper.name)
    expect(await client.callTool({ name: helper.name, arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "insufficient_mcp_scope", requiredScope: "mcp:write", message: `${helper.name} requires the mcp:write scope.` }) }],
    })
  }, overrides, true, connection, true, new Set(["mcp:read", "mcp:app-host"]))
  await withClient({ tools: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(helper.name)
    toolPolicy.disabledTools.push(helper.name)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(helper.name)
    await expect(client.callTool({ name: helper.name, arguments: {} })).rejects.toThrow("not available on the MCP Apps endpoint")
    toolPolicy.disabledTools = []
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(helper.name)
    toolPolicy.allDisabled = true
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(helper.name)
    await expect(client.callTool({ name: helper.name, arguments: {} })).rejects.toThrow("not available on the MCP Apps endpoint")
  }, overrides, true, { ...connection, toolPolicy })
  expect(calls).toBe(0)
})

test.each([true, false, undefined])("App proxy preserves CallToolResult fields (isError=%s)", async (isError) => {
  const result = {
    content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    structuredContent: { serverTools: ["provider-tool"], schemaGuidance: "provider data" },
    _meta: { privateFixture: "view-only" },
    ...(isError === undefined ? {} : { isError }),
  }
  await withClient({ tools: {} }, async (client) => {
    expect(await client.callTool({ name: "open_fixture", arguments: {} })).toEqual(result)
  }, { callTool: async () => result })
})

test("the private App host admits ordinary callbacks without exposing unbound or model-only resources", async () => {
  let downstreamCalls = 0
  let downstreamReads = 0
  const privateResourceUri = "data://fixture/private.json"
  const modelOnlyResourceUri = "ui://fixture/model-only.html"
  await withClient({ tools: {}, resources: {} }, async (client) => {
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
      "open_fixture",
      "search_fixture",
    ])
    for (const tool of tools) expect(tool._meta).toMatchObject({ ui: { visibility: ["app"] } })
    expect(tools.find((tool) => tool.name === "open_fixture")?._meta).toMatchObject({
      ui: { resourceUri, visibility: ["app"] },
    })

    const resources = (await client.listResources()).resources
    expect(resources.map((resource) => resource.uri)).toEqual([resourceUri])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])

    await expect(client.callTool({ name: "model_only_fixture", arguments: {} })).rejects.toThrow(
      "Use search_capabilities and execute_capability",
    )
    await expect(client.readResource({ uri: privateResourceUri })).rejects.toThrow(
      "not bound to an available MCP App tool",
    )
    await expect(client.readResource({ uri: modelOnlyResourceUri })).rejects.toThrow(
      "not bound to an available MCP App tool",
    )
    expect(downstreamCalls).toBe(0)
    expect(downstreamReads).toBe(0)

    const called = await client.callTool({ name: "search_fixture", arguments: { query: "private" } })
    expect(called.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(1)

    const searched = await client.callTool({
      name: "search_capabilities",
      arguments: { query: "private fixture records", limit: 5 },
    })
    const matches = (searched.structuredContent as { matches: Array<Record<string, unknown>> }).matches
    expect(matches).toContainEqual(expect.objectContaining({
      name: "search_fixture",
      invocation: { argumentsField: "body" },
    }))
    const executed = await client.callTool({
      name: "execute_capability",
      arguments: { name: "search_fixture", body: { query: "private" } },
    })
    expect(executed.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(2)

    const opened = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(opened.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(3)
  }, {
    listTools: async () => [
      ...(await runtime().listTools()),
      {
        name: "search_fixture",
        description: "Search private fixture records.",
        inputSchema: { type: "object" },
      },
      {
        name: "model_only_fixture",
        description: "A model-only UI tool that must not be projected into the App host.",
        inputSchema: { type: "object" },
        _meta: { ui: { resourceUri: modelOnlyResourceUri, visibility: ["model"] } },
      },
    ],
    callTool: async () => {
      downstreamCalls += 1
      return {
        content: [{ type: "text" as const, text: "Healthy fixture opened." }],
        structuredContent: { status: "healthy" },
      }
    },
    listResources: async () => [
      { uri: resourceUri, name: "Healthy fixture", mimeType: "text/html;profile=mcp-app" },
      { uri: modelOnlyResourceUri, name: "Model-only fixture", mimeType: "text/html;profile=mcp-app" },
      { uri: privateResourceUri, name: "Private fixture", mimeType: "application/json" },
    ],
    readResource: async () => {
      downstreamReads += 1
      return { contents: [] }
    },
  })
})

test("OAuth registration and network failures become sanitized protocol errors", async () => {
  const oauthFailure = new ExternalMcpDiagnosticError({
    referenceId: "req_oauth_registration",
    phase: "AUTH_CLIENT_REGISTRATION",
    category: "oauth_failure",
    code: "MCP_OAUTH_REGISTRATION_REJECTED",
    highestPassed: "reachable",
    retryable: false,
    actionOwner: "organization_admin",
    message: "The provider rejected OAuth client registration.",
    operatorAction: "Configure a provider-approved OAuth client, then reconnect the MCP connection.",
  })
  const oauthRequest = new Request("https://openwork.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "initialize", params: {} }),
  })
  const oauthResponse = await handleExternalConnectionProxyRequest({
    scopes: new Set(["mcp:read", "mcp:write"]),
    context: requestContext(oauthRequest),
    operation,
    dependencies: { describe: async () => { throw oauthFailure } },
  })
  expect(oauthResponse.status).toBe(200)
  const oauthPayload = await oauthResponse.json() as Record<string, unknown>
  expect(oauthPayload.id).toBe(41)
  expect(oauthPayload).toMatchObject({
    error: {
      code: -32603,
      data: {
        referenceId: "req_oauth_registration",
        diagnosticCode: "MCP_OAUTH_REGISTRATION_REJECTED",
        actionOwner: "organization_admin",
      },
    },
  })
  const serializedOauth = JSON.stringify(oauthPayload)
  expect(serializedOauth).toContain("provider-approved OAuth client")
  expect(serializedOauth).not.toContain("stack")
  expect(serializedOauth).not.toContain("providerResponse")

  const networkRequest = new Request("https://openwork.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "network", method: "initialize", params: {} }),
  })
  const networkResponse = await handleExternalConnectionProxyRequest({
    scopes: new Set(["mcp:read", "mcp:write"]),
    context: requestContext(networkRequest),
    operation: { ...operation, diagnosticReferenceId: "req_network" },
    dependencies: {
      describe: async () => ({ capabilities: {}, serverInfo: { name: "fixture", version: "1.0.0" } }) as never,
      serve: async () => { throw new Error("connect ECONNREFUSED token=do-not-expose") },
    },
  })
  expect(networkResponse.status).toBe(200)
  const networkPayload = await networkResponse.json() as Record<string, unknown>
  expect(networkPayload.id).toBe("network")
  expect(JSON.stringify(networkPayload)).not.toContain("do-not-expose")
  expect(JSON.stringify(networkPayload)).not.toContain("ECONNREFUSED")
})

test("unsupported GET requests never trigger downstream discovery", async () => {
  let discoveryCalls = 0
  const request = new Request("https://openwork.example/mcp", { method: "GET" })
  const response = await handleExternalConnectionProxyRequest({
    scopes: new Set(["mcp:read", "mcp:write"]),
    context: requestContext(request),
    operation,
    dependencies: {
      describe: async () => {
        discoveryCalls += 1
        throw new Error("unexpected discovery")
      },
    },
  })
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("POST")
  expect(discoveryCalls).toBe(0)
})

test("a client that does not advertise the App host capability receives an empty provider index", () => {
  expect(buildConnectMcpServerIndex({
    enabled: false,
    connections: [connection],
    publicOrigin: "https://openwork.example",
  }).servers).toEqual([])
})

test("ordinary clients only see directly exposed connections in the index while the App host sees every ready one", () => {
  const ready = [connection, directConnection]
  const select = (appHostClient: boolean, memberFacingMcpConnectionsEnabled: boolean) =>
    selectConnectMcpServerIndexConnections({ appHostClient, memberFacingMcpConnectionsEnabled, connections: ready })
  expect(select(false, true)).toEqual([directConnection])
  expect(select(false, false)).toEqual([])
  expect(select(true, true)).toEqual(ready)
  expect(buildConnectMcpServerIndex({
    enabled: true,
    connections: select(true, true),
    publicOrigin: "https://openwork.example",
  }).servers.map((server) => server.exposeDirectly)).toEqual([false, true])
})

test("the App host index lists each App the member can use, never exposed directly, in the room connections leave", () => {
  const app = (index: number) => ({
    appId: `cob_01k28e8q8pf8r9sff9mhyq${String(index).padStart(4, "0")}`,
    pluginId: "plg_01k28e8q8pf8r9sff9mhyqxved",
    revisionId: "cov_01k28e8q8pf8r9sff9mhyqxved",
    title: `App ${String(index).padStart(3, "0")}`,
    description: index === 0 ? "d".repeat(2_000) : null,
    serverPath: `/mcp/agent/connections/cob_01k28e8q8pf8r9sff9mhyq${String(index).padStart(4, "0")}`,
  })
  const connections = (count: number) => Array.from({ length: count }, (_, position) => ({
    ...(directConnection as Record<string, unknown>),
    id: `emc_fixture_${String(position).padStart(3, "0")}`,
    name: `Connection ${String(position).padStart(3, "0")}`,
  })) as never[]
  const index = buildConnectMcpServerIndex({
    enabled: true,
    connections: [directConnection],
    apps: [app(1), app(0)],
    publicOrigin: "https://openwork.example",
  })
  expect(index.servers.map((server) => server.name)).toEqual(["App 000", "App 001", "Fixture MCP"])
  // Listed so the App host can open it; its tools never reach the model directly.
  expect(index.servers[0]).toEqual({
    connectionId: app(0).appId,
    name: "App 000",
    description: "d".repeat(1_024),
    url: `https://openwork.example${app(0).serverPath}`,
    exposeDirectly: false,
  })
  expect(index.servers.find((server) => server.name === "Fixture MCP")?.exposeDirectly).toBe(true)

  // Apps take only the room connections leave, in title order.
  expect([0, 1, 99, 100, 150].map(connectMcpServerIndexAppCapacity)).toEqual([100, 99, 1, 0, 0])
  const crowded = buildConnectMcpServerIndex({
    enabled: true,
    connections: [directConnection],
    apps: Array.from({ length: 150 }, (_, position) => app(149 - position)),
    publicOrigin: "https://openwork.example",
  })
  expect(crowded.servers).toHaveLength(100)
  expect(crowded.servers.filter((server) => server.name.startsWith("App ")).map((server) => server.name))
    .toEqual(Array.from({ length: 99 }, (_, position) => app(position).title))
  expect(crowded.servers.some((server) => server.name === "Fixture MCP")).toBe(true)
  const full = buildConnectMcpServerIndex({ enabled: true, connections: connections(100), apps: [app(0)], publicOrigin: "https://openwork.example" })
  expect(full.servers.map((server) => server.name)).not.toContain("App 000")
  expect(full.servers).toHaveLength(100)

  // Without Apps the index is the connection index it has always been, uncapped.
  const plain = buildConnectMcpServerIndex({ enabled: true, connections: connections(120), publicOrigin: "https://openwork.example" })
  expect(plain.servers).toHaveLength(120)
  expect(buildConnectMcpServerIndex({ enabled: true, connections: connections(120), apps: [], publicOrigin: "https://openwork.example" })).toEqual(plain)
  expect(buildConnectMcpServerIndex({ enabled: false, connections: [], apps: [app(1)], publicOrigin: "https://openwork.example" }).servers).toEqual([])
})

test("disconnected and issuer-blocked OAuth connections are not ready for the native server index", async () => {
  const memberId = "mem_01k28e8q8pf8r9sff9mhyqxved" as never
  const base = {
    ...connection,
    authType: "oauth",
    credentialMode: "shared",
    accessToken: null,
  } as never
  expect(await externalMcpConnectionReadyForMember(base, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, accessToken: "shared-token" } as never, memberId)).toBe(true)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    authType: "apikey",
    accessToken: null,
    apiKey: null,
  } as never, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    authType: "apikey",
    accessToken: null,
    apiKey: "shared-api-key",
  } as never, memberId)).toBe(true)
  expect(await externalMcpConnectionReadyForMember({
    ...base,
    accessToken: "shared-token",
    oauthIssuerReviewRequiredAt: new Date(),
  } as never, memberId)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, credentialMode: "per_member" } as never, memberId, async () => ({
    current: true,
    value: null,
  }) as never)).toBe(false)
  expect(await externalMcpConnectionReadyForMember({ ...base, credentialMode: "per_member" } as never, memberId, async () => ({
    current: true,
    value: { accessToken: "member-token" },
  }) as never)).toBe(true)

  const ready = await readyExternalMcpConnectionsForMember([base], memberId)
  expect(buildConnectMcpServerIndex({
    enabled: true,
    connections: ready,
    publicOrigin: "https://openwork.example",
  }).servers).toEqual([])
})
