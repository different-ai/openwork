import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

type OpenApiDocument = {
  paths: Record<string, Record<string, { operationId?: string; tags?: string[] }>>
}

let isMcpOperationAllowed: typeof import("../src/mcp/policy.js")["isMcpOperationAllowed"]
let isAgentApiKeyConnection: typeof import("../src/routes/org/mcp-connections.js")["isAgentApiKeyConnection"]
let isAgentOAuthClientConnection: typeof import("../src/routes/org/mcp-connections.js")["isAgentOAuthClientConnection"]
let isAgentPluginMcpSecretSetup: typeof import("../src/routes/org/plugin-system/routes.js")["isAgentPluginMcpSecretSetup"]
let buildMcpCatalog: typeof import("../src/mcp/catalog.js")["buildMcpCatalog"]
let searchCapabilities: typeof import("../src/mcp/search.js")["searchCapabilities"]
let searchCapabilitySourceFilter: typeof import("../src/mcp/search.js")["searchCapabilitySourceFilter"]
let document: OpenApiDocument

function findOperation(operationId: string) {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation && typeof operation === "object" && operation.operationId === operationId) {
        return { method, path, operation }
      }
    }
  }
  throw new Error(`Operation not found in openapi.json: ${operationId}`)
}

function allowed(operationId: string) {
  const { method, path, operation } = findOperation(operationId)
  return isMcpOperationAllowed({ method, path, operation })
}

beforeAll(async () => {
  seedRequiredEnv()
  isMcpOperationAllowed = (await import("../src/mcp/policy.js")).isMcpOperationAllowed
  buildMcpCatalog = (await import("../src/mcp/catalog.js")).buildMcpCatalog
  searchCapabilities = (await import("../src/mcp/search.js")).searchCapabilities
  searchCapabilitySourceFilter = (await import("../src/mcp/search.js")).searchCapabilitySourceFilter
  const mcpConnections = await import("../src/routes/org/mcp-connections.js")
  isAgentApiKeyConnection = mcpConnections.isAgentApiKeyConnection
  isAgentOAuthClientConnection = mcpConnections.isAgentOAuthClientConnection
  isAgentPluginMcpSecretSetup = (await import("../src/routes/org/plugin-system/routes.js")).isAgentPluginMcpSecretSetup
  const app = (await import("../src/app.js")).default
  const response = await app.request("http://127.0.0.1:8790/openapi.json")
  document = await response.json()
})

describe("agent-configurable org connections policy", () => {
  test("the agent can create connections and manage access (admin-enforced in-route)", () => {
    expect(allowed("postV1McpConnections")).toBe(true)
    expect(allowed("putV1McpConnectionsByConnectionIdAccess")).toBe(true)
  })

  test("OAuth plumbing and destructive operations stay human-only", () => {
    expect(allowed("getV1McpConnectionsByConnectionIdConnectStart")).toBe(false)
    expect(allowed("getV1McpConnectionsByConnectionIdConnectCallback")).toBe(false)
    expect(allowed("deleteV1McpConnectionsByConnectionId")).toBe(false)
    expect(allowed("postV1McpConnectionsByConnectionIdDisconnect")).toBe(false)
    expect(allowed("postV1OauthProvidersByProviderIdClient")).toBe(false)
    expect(allowed("postV1OauthProvidersByProviderIdDisconnect")).toBe(false)
  })

  test("discovery surfaces the agent needs are readable", () => {
    expect(allowed("getV1McpConnections")).toBe(true)
    expect(allowed("getV1McpConnectionsPresets")).toBe(true)
    expect(allowed("getV1McpConnectionsByConnectionIdTools")).toBe(true)
  })

  test("manual MCP tool execution stays outside the agent API catalog", () => {
    const operation = document.paths["/v1/mcp-connections/{connectionId}/tools/call"]?.post
    expect(operation).toBeDefined()
    expect(operation ? isMcpOperationAllowed({
      method: "post",
      path: "/v1/mcp-connections/{connectionId}/tools/call",
      operation,
    }) : true).toBe(false)
  })

  test("agent catalog search discovers member list and admin create mcp-connection operations", () => {
    const catalog = buildMcpCatalog(document)
    const memberMatches = searchCapabilities(catalog, "list external mcp connections", 10)
    const adminMatches = searchCapabilities(catalog, "register external mcp connection", 10)
    const toolCatalogMatches = searchCapabilities(catalog, "inspect tools exposed by an external mcp connection", 10)

    expect(memberMatches).toContainEqual(expect.objectContaining({
      name: "getMcpConnections",
      method: "GET",
      path: "/v1/mcp-connections",
    }))
    expect(adminMatches).toContainEqual(expect.objectContaining({
      name: "postMcpConnections",
      method: "POST",
      path: "/v1/mcp-connections",
      hasBody: true,
    }))
    expect(toolCatalogMatches).toContainEqual(expect.objectContaining({
      method: "GET",
      path: "/v1/mcp-connections/{connectionId}/tools",
    }))
  })

  test("plugin MCP requirements are agent-configurable without exposing secret setup", () => {
    expect(allowed("postV1PluginsByPluginIdMcpConnections")).toBe(true)
    expect(document.paths["/v1/plugins/{pluginId}/mcp-requirements/configure"]).toBeUndefined()
    const catalog = buildMcpCatalog(document)
    expect(catalog.some((operation) => operation.path === "/v1/plugins/{pluginId}/mcp-connections")).toBe(true)
    expect(searchCapabilities(catalog, "configure plugin mcp requirement per member oauth", 20)).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/v1/plugins/{pluginId}/mcp-connections",
    }))
  })

  test("agent capability search source filter can restrict searches to skills", () => {
    expect(searchCapabilitySourceFilter()).toEqual({
      api: true,
      admin: true,
      mcp: true,
      marketplace: true,
      skills: true,
    })
    expect(searchCapabilitySourceFilter("skills")).toEqual({
      api: false,
      admin: false,
      mcp: false,
      marketplace: true,
      skills: true,
    })
    expect(searchCapabilitySourceFilter("admin")).toEqual({
      api: false,
      admin: true,
      mcp: false,
      marketplace: false,
      skills: false,
    })
  })

  test("API-key connections are blocked only for the internal agent principal", () => {
    expect(isAgentApiKeyConnection({ authType: "apikey", sessionId: "mcp_internal" })).toBe(true)
    expect(isAgentApiKeyConnection({ authType: "oauth", sessionId: "mcp_internal" })).toBe(false)
    expect(isAgentApiKeyConnection({ authType: "none", sessionId: "mcp_internal" })).toBe(false)
    expect(isAgentApiKeyConnection({ authType: "apikey", sessionId: "normal_session" })).toBe(false)
    expect(isAgentApiKeyConnection({ authType: "apikey", sessionId: null })).toBe(false)
  })

  test("OAuth clients are blocked only for the internal agent principal", () => {
    expect(isAgentOAuthClientConnection({ oauthClient: { clientId: "client" }, sessionId: "mcp_internal" })).toBe(true)
    expect(isAgentOAuthClientConnection({ oauthClient: { clientId: "client" }, sessionId: "normal_session" })).toBe(false)
    expect(isAgentOAuthClientConnection({ sessionId: "mcp_internal" })).toBe(false)
    expect(isAgentOAuthClientConnection({ oauthClient: null, sessionId: "mcp_internal" })).toBe(false)
  })

  test("plugin MCP secret setup is blocked for the internal agent principal", () => {
    expect(isAgentPluginMcpSecretSetup({ oauthClient: { clientId: "client" }, sessionId: "mcp_internal" })).toBe(true)
    expect(isAgentPluginMcpSecretSetup({ apiKey: "exa-key", sessionId: "mcp_internal" })).toBe(true)
    expect(isAgentPluginMcpSecretSetup({ apiKey: "exa-key", sessionId: "normal_session" })).toBe(false)
    expect(isAgentPluginMcpSecretSetup({ oauthClient: { clientId: "client" }, sessionId: "normal_session" })).toBe(false)
    expect(isAgentPluginMcpSecretSetup({ apiKey: " ", sessionId: "mcp_internal" })).toBe(false)
    expect(isAgentPluginMcpSecretSetup({ sessionId: "mcp_internal" })).toBe(false)
  })
})
