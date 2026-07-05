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
  const mcpConnections = await import("../src/routes/org/mcp-connections.js")
  isAgentApiKeyConnection = mcpConnections.isAgentApiKeyConnection
  isAgentOAuthClientConnection = mcpConnections.isAgentOAuthClientConnection
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
})
