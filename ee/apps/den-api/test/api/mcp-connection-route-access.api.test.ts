import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import type { ExternalMcpConnectionRow } from "../../src/capability-sources/external-mcp-connections.js"
import type { McpPrincipal } from "../../src/mcp/auth.js"
import type { ConnectionServerRouteDeps } from "../../src/mcp/connection-server.js"
import type { ExternalConnectionProxyRouteDeps } from "../../src/mcp/external-connection-proxy.js"
import { bootDen, field } from "./harness.js"

/**
 * The two routes that serve one connection on its own answer the same access
 * questions as execute_capability. A malformed id goes through the real app.
 * The held and withheld cases supply the routes' lookups, so each names
 * exactly the connection and the token it is about.
 */
const den = await bootDen()
after(() => den.close())
// Loading the routes starts Better Auth's resource registry; wait for it.
await import("../../src/auth.js").then(({ auth }) => auth.$context)
const { registerExternalConnectionProxyRoutes } = await import("../../src/mcp/external-connection-proxy.js")
const { registerConnectionServerRoutes } = await import("../../src/mcp/connection-server.js")

const ORIGIN = "http://den-api.example.test"
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const WORKBOT_WITHOUT = "openwork:workbot-without-connection:"

function connection(overrides: Partial<ExternalMcpConnectionRow> = {}): ExternalMcpConnectionRow {
  return {
    id: createDenTypeId("externalMcpConnection"),
    organizationId,
    name: "Team Notes",
    externalKey: null,
    url: "http://provider.example.test/mcp",
    authType: "oauth",
    kind: "external_mcp",
    nativeProviderKey: null,
    oauthConfiguration: null,
    toolPolicy: null,
    exposeDirectly: true,
    credentialMode: "shared",
    apiKey: null,
    apiKeyAuthScheme: "bearer",
    requestHeaders: null,
    accessToken: "saved-access-token",
    refreshToken: null,
    tokenType: "Bearer",
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    credentialHealth: null,
    readinessCheck: null,
    readinessCredentialBinding: null,
    oauthIssuerReviewRequiredAt: null,
    connectedAt: new Date(),
    createdByOrgMembershipId: memberId,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function principal(extraScopes: string[]): McpPrincipal {
  return { userId: createDenTypeId("user"), organizationId, scopes: new Set(["mcp:read", "mcp:write", ...extraScopes]), payload: {} }
}

function post(app: { request: (url: string, init: RequestInit) => Response | Promise<Response> }, path: string, method: string) {
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  })
}

/** The per-connection route with one connection in the organization; `served` lists what reached the provider. */
function connectionRoute(input: { row: ExternalMcpConnectionRow; granted?: boolean; scopes?: string[] }) {
  const served: string[] = []
  const deps: ExternalConnectionProxyRouteDeps = {
    verify: async () => principal(input.scopes ?? []),
    member: async () => ({ orgMembershipId: memberId, teamIds: [] }),
    connection: async ({ connectionId }) => connectionId === input.row.id ? input.row : null,
    granted: async () => input.granted ?? true,
    memberKeyReady: async () => true,
    toolShapes: async () => false,
    proxy: async ({ operation }) => {
      served.push(operation.connection.id)
      return new Response("served")
    },
  }
  const app = new Hono<{ Variables: RequestIdVariables & Record<string, unknown> }>()
  registerExternalConnectionProxyRoutes(app, deps)
  return {
    served,
    call: async (id: string = input.row.id) => {
      const response = await post(app, `/mcp/agent/connections/${encodeURIComponent(id)}`, "tools/list")
      const text = await response.text()
      const body: unknown = response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null
      const record = typeof body === "object" && body !== null ? body : {}
      return {
        status: response.status,
        error: "error" in record ? record.error : undefined,
        message: "message" in record && typeof record.message === "string" ? record.message : "",
        text,
      }
    },
  }
}

test("a connection the member was granted is served", async () => {
  const route = connectionRoute({ row: connection() })
  const reply = await route.call()

  assert.equal(reply.status, 200)
  assert.equal(reply.text, "served")
  assert.equal(route.served.length, 1)
})

test("a connection held for an admin's review of its changed sign-in provider is not served", async () => {
  const route = connectionRoute({ row: connection({ oauthIssuerReviewRequiredAt: new Date() }) })
  const reply = await route.call()

  assert.equal(reply.status, 403)
  assert.equal(reply.error, "connection_not_available")
  assert.match(reply.message, /"Team Notes" is blocked until an organization admin reviews its changed OAuth issuer/)
  assert.deepEqual(route.served, [])
})

test("a connection an admin took away from Workbot is not served to a Workbot turn", async () => {
  const row = connection()
  const workbot = connectionRoute({ row, scopes: [`${WORKBOT_WITHOUT}${row.id}`] })
  const reply = await workbot.call()

  assert.equal(reply.status, 403)
  assert.equal(reply.error, "connection_not_available")
  assert.match(reply.message, /"Team Notes" isn't allowed for Workbot in your organization/)
  assert.deepEqual(workbot.served, [])

  // The same member everywhere else, and a Workbot turn that lost a different connection, still reach it.
  const elsewhere = connectionRoute({ row, scopes: [`${WORKBOT_WITHOUT}${createDenTypeId("externalMcpConnection")}`] })
  assert.equal((await elsewhere.call()).status, 200)
  assert.equal(elsewhere.served.length, 1)
})

test("a member without a grant is not told why a connection is held", async () => {
  const route = connectionRoute({ row: connection({ oauthIssuerReviewRequiredAt: new Date() }), granted: false })
  const reply = await route.call()

  assert.equal(reply.status, 403)
  assert.equal(reply.error, "connection_not_available")
  assert.equal(reply.message, "")
  assert.deepEqual(route.served, [])
})

test("a malformed connection id is refused like an unknown one", async () => {
  const owner = await den.signUp("Route Owner")
  const { orgId } = await den.createOrg(owner, "Route Access Org")
  const token = await den.mintMcpToken(owner, orgId)
  const ask = (id: string) => den.request(token, "POST", `/mcp/agent/connections/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })

  const malformed = await ask("not-a-connection-id")
  const unknown = await ask(createDenTypeId("externalMcpConnection"))

  assert.equal(malformed.status, 403, malformed.text)
  assert.equal(field(malformed.body, "error"), "connection_not_available")
  assert.equal(unknown.status, 403, unknown.text)
  assert.deepEqual(malformed.body, unknown.body)
})

/** The connection's own MCP server route, with the connection connected and one tool. */
function serverRoute(input: { row: ExternalMcpConnectionRow; scopes: string[] }) {
  const deps: ConnectionServerRouteDeps = {
    verify: async () => principal(input.scopes),
    features: async () => ({ connectionMcpServers: true, managedDeployments: false }),
    member: async () => ({ orgMembershipId: memberId, teamIds: [] }),
    catalog: async () => [],
    sources: {
      externalConnection: async ({ connectionId }) => connectionId === input.row.id ? input.row : null,
      externalStatus: async () => ({ ok: true, connected: true, connection: { id: input.row.id, name: input.row.name } }),
      externalTools: async () => [{ name: "list_notes", description: "List notes.", inputSchema: { type: "object" } }],
      nativeEntries: async () => [],
    },
    executeCapability: async () => { throw new Error("no tool is called here") },
    withBudget: async (_capability, invoke) => invoke(),
    revision: async () => null,
  }
  const app = new Hono<{ Variables: RequestIdVariables & Record<string, unknown> }>()
  registerConnectionServerRoutes(app, deps)
  return async () => {
    const response = await post(app, `/mcp/agent/servers/${encodeURIComponent(input.row.id)}`, "tools/list")
    return response.text()
  }
}

test("a connection's own server is not available to a Workbot turn it was taken away from", async () => {
  const row = connection()
  const listed = await serverRoute({ row, scopes: [] })()
  assert.match(listed, /list_notes/)

  const withheld = await serverRoute({ row, scopes: [`${WORKBOT_WITHOUT}${row.id}`] })()
  assert.match(withheld, /mcp_connection_not_found/)
  assert.doesNotMatch(withheld, /list_notes/)
})
