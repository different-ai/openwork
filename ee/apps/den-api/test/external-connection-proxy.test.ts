import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
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
const { buildConnectMcpServerIndex, selectConnectMcpServerIndexConnections } = await import("../src/mcp/connect-mcp-server-index.js")

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
) {
  const server = createExternalConnectionProxyServer({
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
      .rejects.toThrow("only through the OpenWork App host")
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
      .rejects.toThrow("only through the OpenWork App host")
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
    expect((await client.listResources()).resources).toEqual([])
    const called = await client.callTool({ name: "search_fixture", arguments: { query: "direct" } })
    expect(called.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(1)
    expect(downstreamCalledWith).toMatchObject({ toolName: "search_fixture", args: { query: "direct" } })
    await expect(client.callTool({ name: "app_only_fixture", arguments: {} })).rejects.toThrow("is not available on Fixture MCP")
    await expect(client.callTool({ name: "blocked_fixture", arguments: {} })).rejects.toThrow("is not available on Fixture MCP")
    await expect(client.callTool({ name: "search_capabilities", arguments: { query: "direct" } })).rejects.toThrow("is not available on Fixture MCP")
    await expect(client.readResource({ uri: resourceUri })).rejects.toThrow("only through the OpenWork App host")
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

test("direct exposure stays closed while the organization has member-facing MCP connections disabled", async () => {
  let downstreamCalls = 0
  await withClient({ tools: {}, resources: {} }, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
      "execute_capability",
    ])
    await expect(client.callTool({ name: "open_fixture", arguments: {} }))
      .rejects.toThrow("Use search_capabilities and execute_capability")
    expect(downstreamCalls).toBe(0)
  }, {
    callTool: async () => {
      downstreamCalls += 1
      return { content: [], structuredContent: {} }
    },
  }, false, directConnection, false)
})

test("the request handler never enables direct exposure unless the route confirms the organization flag", async () => {
  let toolNames: string[] = []
  const request = new Request("https://openwork.example/mcp/agent/connections/fixture", { method: "POST" })
  await handleExternalConnectionProxyRequest({
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

test("a regular MCP with an App keeps every model-visible tool behind search and execute", async () => {
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
    ])
    for (const tool of tools) expect(tool._meta).toMatchObject({ ui: { visibility: ["app"] } })
    expect(tools.find((tool) => tool.name === "open_fixture")?._meta).toMatchObject({
      ui: { resourceUri, visibility: ["app"] },
    })

    const resources = (await client.listResources()).resources
    expect(resources.map((resource) => resource.uri)).toEqual([resourceUri])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([])

    await expect(client.callTool({ name: "search_fixture", arguments: { query: "private" } })).rejects.toThrow(
      "Use search_capabilities and execute_capability",
    )
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
    expect(downstreamCalls).toBe(1)

    const opened = await client.callTool({ name: "open_fixture", arguments: {} })
    expect(opened.structuredContent).toEqual({ status: "healthy" })
    expect(downstreamCalls).toBe(2)
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
