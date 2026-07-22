import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { McpAuthResourceContext } from "../src/mcp/auth.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type SelectedRow =
  | { id: string }
  | {
    token: string
    clientId: string
    userId: string
    sessionId: string
    referenceId: string
    expiresAt: Date
    createdAt: Date
    scopes: string
  }

let selectedRows: SelectedRow[] = []
let selectedRowBatches: SelectedRow[][] = []
let sessionUpdates: Array<{ expiresAt: Date; updatedAt: Date }> = []
let jwtPayload: Record<string, unknown> = {}
let platformAdmin = false
let mcpAuth: typeof import("../src/mcp/auth.js")
let registerMcpRoutes: typeof import("../src/mcp/index.js")["registerMcpRoutes"]
let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]
let registerAdminMcpRoutes: typeof import("../src/mcp/admin.js")["registerAdminMcpRoutes"]

const OPAQUE_SECRET = "mcp_test_secret"
const OPAQUE_TOKEN = `ow_mcp_at_${OPAQUE_SECRET}`

function nextSelectedRows() {
  return selectedRowBatches.shift() ?? selectedRows
}

beforeAll(async () => {
  seedRequiredEnv()

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
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
    DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))

  mock.module("../src/db.js", () => ({
    db: {
      update: () => ({
        set: (values: { expiresAt: Date; updatedAt: Date }) => ({
          where: () => {
            sessionUpdates.push(values)
            return Promise.resolve()
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(nextSelectedRows()),
          }),
        }),
      }),
    },
  }))

  mock.module("better-auth/oauth2", () => ({
    verifyJwsAccessToken: () => Promise.resolve(jwtPayload),
  }))

  mock.module("../src/middleware/admin.js", () => ({
    isPlatformAdminUserId: () => Promise.resolve(platformAdmin),
  }))

  mcpAuth = await import("../src/mcp/auth.js")
  registerMcpRoutes = (await import("../src/mcp/index.js")).registerMcpRoutes
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
  registerAdminMcpRoutes = (await import("../src/mcp/admin.js")).registerAdminMcpRoutes
})

afterAll(() => {
  mock.restore()
})

test("MCP principals require an active organization membership", async () => {
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")

  selectedRows = [{ id: createDenTypeId("member") }]
  await expect(mcpAuth.hasActiveMcpMembership({
    userId,
    organizationId,
  })).resolves.toBe(true)

  selectedRows = []
  await expect(mcpAuth.hasActiveMcpMembership({
    userId,
    organizationId,
  })).resolves.toBe(false)
})

test("MCP membership check rejects malformed principals", async () => {
  selectedRows = [{ id: "member_active" }]
  await expect(mcpAuth.hasActiveMcpMembership({
    userId: "not-a-user-id",
    organizationId: createDenTypeId("organization"),
  })).resolves.toBe(false)
})

test("MCP bearer tokens tied to deleted sessions are rejected", async () => {
  const sessionId = createDenTypeId("session")
  const now = new Date("2026-07-09T12:00:00.000Z")

  sessionUpdates = []
  selectedRows = [{ id: sessionId }]
  await expect(mcpAuth.hasActiveMcpSession(sessionId, now)).resolves.toBe(true)
  expect(sessionUpdates).toEqual([{
    updatedAt: now,
    expiresAt: new Date("2026-07-16T12:00:00.000Z"),
  }])

  selectedRows = []
  selectedRowBatches = []
  await expect(mcpAuth.hasActiveMcpSession(sessionId, now)).resolves.toBe(false)
  await expect(mcpAuth.hasActiveMcpSession("not-a-session-id")).resolves.toBe(false)
})

function agentResourceContext(requestId = "req_mcp_auth"): McpAuthResourceContext {
  return {
    route: "agent",
    resourceUrl: "http://127.0.0.1:8790/mcp/agent",
    metadataUrl: "http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp/agent",
    oauthResources: ["http://127.0.0.1:8790/mcp/agent"],
    firstPartyResources: ["http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin"],
    requestId,
  }
}

function parentResourceContext(requestId = "req_mcp_auth"): McpAuthResourceContext {
  return {
    route: "mcp",
    resourceUrl: "http://127.0.0.1:8790/mcp",
    metadataUrl: "http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp",
    oauthResources: [],
    firstPartyResources: ["http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin"],
    requestId,
  }
}

function adminResourceContext(requestId = "req_mcp_auth"): McpAuthResourceContext {
  return {
    route: "admin",
    resourceUrl: "http://127.0.0.1:8790/mcp",
    metadataUrl: "http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp",
    oauthResources: [],
    firstPartyResources: ["http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin"],
    requestId,
  }
}

function validMcpJwtPayload(input: { resource: string; clientId?: string }) {
  return {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: input.clientId ?? "client_mcp_test",
    scope: "mcp:read mcp:write",
    client_id: input.clientId,
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": input.resource,
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
    sid: createDenTypeId("session"),
  }
}

function selectActiveSessionAndMembership() {
  selectedRows = []
  selectedRowBatches = [[{ id: createDenTypeId("session") }], [{ id: createDenTypeId("member") }]]
}

function validFirstPartyOpaqueTokenRow() {
  return {
    token: mcpAuth.hashOpaqueMcpSecret(OPAQUE_SECRET),
    clientId: "openwork-desktop",
    userId: createDenTypeId("user"),
    sessionId: createDenTypeId("session"),
    referenceId: createDenTypeId("organization"),
    expiresAt: new Date("2999-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-07-09T12:00:00.000Z"),
    scopes: JSON.stringify(["mcp:read", "mcp:write"]),
  }
}

function selectActiveOpaqueTokenSessionAndMembership() {
  selectedRows = []
  selectedRowBatches = [
    [validFirstPartyOpaqueTokenRow()],
    [{ id: createDenTypeId("session") }],
    [{ id: createDenTypeId("member") }],
  ]
}

function buildMcpRouteApp(requestId: string) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => {
    c.set("requestId", requestId)
    await next()
  })
  return app
}

test("MCP requests without bearer tokens return discovery challenges", async () => {
  const response = await mcpAuth.verifyMcpRequest(new Headers(), agentResourceContext("req_missing"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain("resource_metadata=\"http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp/agent\"")
    expect(challenge).toContain("scope=\"mcp:read mcp:write offline_access\"")
    await expect(response.json()).resolves.toMatchObject({ error: "missing_mcp_token", referenceId: "req_missing" })
  }
})

test("invalid MCP bearer tokens return invalid_token with references", async () => {
  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer not-an-mcp-token",
  }), agentResourceContext("req_invalid"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain('scope="mcp:read mcp:write offline_access"')
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_mcp_token", oauthError: "invalid_token", referenceId: "req_invalid" })
  }
})

test("MCP JWTs without required scopes return insufficient_scope", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: "client_mcp_test",
    scope: "profile",
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp/agent",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
    sid: createDenTypeId("session"),
  }

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_scope"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(403)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="mcp:read mcp:write offline_access"')
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_mcp_scope", oauthError: "insufficient_scope", referenceId: "req_scope" })
  }
})

test("MCP JWTs with the wrong token use are rejected as invalid_token", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: "client_mcp_test",
    scope: "mcp:read",
    "https://openworklabs.com/token_use": "session",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp/agent",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
    sid: createDenTypeId("session"),
  }

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_wrong_use"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: "wrong_token_use", oauthError: "invalid_token", referenceId: "req_wrong_use" })
  }
})

test("MCP JWTs for the wrong resource are rejected as invalid_token", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: "client_mcp_test",
    scope: "mcp:read",
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
    sid: createDenTypeId("session"),
  }

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_resource"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: "wrong_mcp_resource", oauthError: "invalid_token", referenceId: "req_resource" })
  }
})

test("MCP JWTs without session claims are rejected", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: "client_mcp_test",
    scope: "mcp:read mcp:write",
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp/agent",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
  }

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_session"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: "mcp_session_required", oauthError: "invalid_token", referenceId: "req_session" })
  }
})

test("MCP JWTs tied to revoked sessions retain the established body code", async () => {
  jwtPayload = validMcpJwtPayload({ resource: "http://127.0.0.1:8790/mcp/agent" })
  selectedRows = []
  selectedRowBatches = [[]]

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_revoked_session"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: "mcp_session_revoked", oauthError: "invalid_token", referenceId: "req_revoked_session" })
  }
})

test("public MCP JWTs issued for /mcp/agent are rejected on /mcp", async () => {
  jwtPayload = validMcpJwtPayload({ resource: "http://127.0.0.1:8790/mcp/agent" })

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), parentResourceContext("req_parent_jwt_resource"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    const challenge = response.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain("resource_metadata=\"http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp\"")
    await expect(response.json()).resolves.toMatchObject({ error: "wrong_mcp_resource", oauthError: "invalid_token", referenceId: "req_parent_jwt_resource" })
  }
})

test("first-party opaque desktop tokens remain accepted on parent and admin MCP resources", async () => {
  selectActiveOpaqueTokenSessionAndMembership()
  const parentPrincipal = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: `Bearer ${OPAQUE_TOKEN}`,
  }), parentResourceContext("req_parent_opaque"))

  expect(parentPrincipal).not.toBeInstanceOf(Response)

  selectActiveOpaqueTokenSessionAndMembership()
  const adminPrincipal = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: `Bearer ${OPAQUE_TOKEN}`,
  }), adminResourceContext("req_admin_opaque"))

  expect(adminPrincipal).not.toBeInstanceOf(Response)
})

test("JWT client_id cannot make external tokens use first-party resource aliases", async () => {
  jwtPayload = validMcpJwtPayload({
    resource: "http://127.0.0.1:8790/mcp",
    clientId: "openwork-desktop",
  })
  selectActiveSessionAndMembership()

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_first_party"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: "wrong_mcp_resource", oauthError: "invalid_token", referenceId: "req_first_party" })
  }
})

test("admin MCP route still requires the platform-admin allowlist after token verification", async () => {
  platformAdmin = false
  selectActiveOpaqueTokenSessionAndMembership()
  const app = buildMcpRouteApp("req_admin_allowlist")
  registerAdminMcpRoutes(app)

  const response = await app.request("http://127.0.0.1:8790/mcp/admin", {
    method: "POST",
    headers: { authorization: `Bearer ${OPAQUE_TOKEN}` },
  })

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "admin_required" })
})

test("public MCP JWTs issued for /mcp/agent are rejected on /mcp/admin", async () => {
  jwtPayload = validMcpJwtPayload({ resource: "http://127.0.0.1:8790/mcp/agent" })
  const app = buildMcpRouteApp("req_admin_jwt_resource")
  registerAdminMcpRoutes(app)

  const response = await app.request("http://127.0.0.1:8790/mcp/admin", {
    method: "POST",
    headers: { authorization: "Bearer header.payload.signature" },
  })

  expect(response.status).toBe(401)
  const challenge = response.headers.get("www-authenticate") ?? ""
  expect(challenge).toContain("resource_metadata=\"http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp\"")
  await expect(response.json()).resolves.toMatchObject({ error: "wrong_mcp_resource", oauthError: "invalid_token", referenceId: "req_admin_jwt_resource" })
})

test("authenticated /mcp malformed JSON-RPC is rejected before transport", async () => {
  selectActiveOpaqueTokenSessionAndMembership()
  const app = buildMcpRouteApp("req_mcp_preflight")
  registerMcpRoutes(app)

  const response = await app.request("http://127.0.0.1:8790/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${OPAQUE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {} }),
  })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({
    jsonrpc: "2.0",
    error: { code: -32600, message: "Invalid Request", data: { referenceId: "req_mcp_preflight" } },
  })
})

test("authenticated /mcp/agent malformed JSON-RPC is rejected before transport", async () => {
  jwtPayload = validMcpJwtPayload({ resource: "http://127.0.0.1:8790/mcp/agent" })
  selectActiveSessionAndMembership()
  const app = buildMcpRouteApp("req_agent_preflight")
  registerAgentMcpRoutes(app)

  const response = await app.request("http://127.0.0.1:8790/mcp/agent", {
    method: "POST",
    headers: { authorization: "Bearer header.payload.signature", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {} }),
  })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({
    jsonrpc: "2.0",
    error: { code: -32600, message: "Invalid Request", data: { referenceId: "req_agent_preflight" } },
  })
})

test("authenticated /mcp/admin malformed JSON-RPC is rejected for admins before transport", async () => {
  platformAdmin = true
  try {
    selectActiveOpaqueTokenSessionAndMembership()
    const app = buildMcpRouteApp("req_admin_preflight")
    registerAdminMcpRoutes(app)

    const response = await app.request("http://127.0.0.1:8790/mcp/admin", {
      method: "POST",
      headers: { authorization: `Bearer ${OPAQUE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, params: {} }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request", data: { referenceId: "req_admin_preflight" } },
    })
  } finally {
    platformAdmin = false
  }
})

test("MCP JWTs tied to revoked memberships stay forbidden", async () => {
  jwtPayload = {
    sub: createDenTypeId("user"),
    aud: "http://127.0.0.1:8790/mcp/agent",
    azp: "client_mcp_test",
    scope: "mcp:read mcp:write",
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": "http://127.0.0.1:8790/mcp/agent",
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
    sid: createDenTypeId("session"),
  }
  selectedRows = []
  selectedRowBatches = [[{ id: createDenTypeId("session") }], []]

  const response = await mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext("req_membership"))

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: "mcp_membership_revoked", referenceId: "req_membership" })
  }
})
