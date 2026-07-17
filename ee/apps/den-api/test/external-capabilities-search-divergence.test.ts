import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_searchdiv"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

// src/env.ts is a parse-once singleton: whichever test file imports it first
// fixes the flags for the whole bun process. Seed at module load (not just in
// beforeAll) so co-running with other suites can't strip
// DEN_ALLOW_PRIVATE_MCP_URLS and SSRF-block this file's 127.0.0.1 fake servers.
seedRequiredEnv()

const redirectUriBase = "http://127.0.0.1:8790"

type FakeTool = {
  name: string
  description: string
}

type FakeMcpServer = {
  url: string
  stop: () => void
}

type SeededOrganization = {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
}

type ConnectionInput = {
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string | null
}

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let listExternalMcpTools: typeof import("../src/capability-sources/external-mcp-client.js").listExternalMcpTools
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection
let getExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").getExternalMcpConnection
let listUsableExternalMcpConnections: typeof import("../src/capability-sources/external-mcp-connections.js").listUsableExternalMcpConnections
let saveExternalMcpTokens: typeof import("../src/capability-sources/external-mcp-connections.js").saveExternalMcpTokens
let searchExternalCapabilities: typeof import("../src/mcp/external-capabilities.js").searchExternalCapabilities
let executeExternalCapability: typeof import("../src/mcp/external-capabilities.js").executeExternalCapability
let slackServer: FakeMcpServer | undefined
let authedSlackServer: FakeMcpServer | undefined
let notionServer: FakeMcpServer | undefined
let refreshErrorServer: FakeMcpServer | undefined
let providerErrorServer: FakeMcpServer | undefined
let needleServer: FakeMcpServer | undefined

const slackTools: FakeTool[] = [
  { name: "slack-send-message", description: "Send a message to a Slack channel or DM." },
  { name: "slack-list-channels", description: "List Slack channels in the workspace." },
  { name: "slack-search-messages", description: "Search Slack messages across channels." },
  { name: "slack-create-reminder", description: "Create a Slack reminder for a user." },
  { name: "slack-post-update", description: "Post a status update to a Slack channel." },
]

const notionTools: FakeTool[] = [
  {
    name: "notion-search",
    description: "Search the user's Notion workspace and connected sources (Slack, Google Drive, GitHub) and return ranked results.",
  },
]

function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }]
}

function startFakeMcpServer(name: string, tools: FakeTool[], requiredBearer?: string): FakeMcpServer {
  const app = new Hono()
  app.all("/mcp", async (c) => {
    if (requiredBearer && c.req.header("authorization") !== `Bearer ${requiredBearer}`) {
      return c.json({ error: "invalid_token" }, 401)
    }
    const server = new McpServer({ name, version: "1.0.0" })
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: z.object({ text: z.string().optional() }),
        },
        async ({ text }) => ({ content: textContent(text ?? `${tool.name} ok`) }),
      )
    }
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c)
    return response ?? new Response(null, { status: 204 })
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  }
}

function startErrorMcpServer(message: string): FakeMcpServer {
  const app = new Hono()
  app.all("/mcp", async (c) => {
    const payload: unknown = await c.req.json()
    const requestId = typeof payload === "object" && payload !== null && "id" in payload
      && (typeof payload.id === "string" || typeof payload.id === "number")
      ? payload.id
      : null
    return c.json({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32603, message },
    })
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  }
}

function startProviderErrorMcpServer(): FakeMcpServer {
  const app = new Hono()
  app.all("/mcp", async (c) => {
    const server = new McpServer({ name: "provider-error", version: "1.0.0" })
    server.registerTool(
      "create_change",
      { description: "Create an enterprise change", inputSchema: z.object({}) },
      async () => ({
        isError: true,
        content: textContent("Provider ACL denied this operation; internal detail must not escape."),
      }),
    )
    server.registerTool(
      "read_denied_change",
      { description: "Read a synthetic enterprise change", inputSchema: z.object({}) },
      async () => ({
        isError: true,
        content: textContent("Sensitive provider policy detail must not escape."),
        structuredContent: {
          category: "provider_policy",
          providerStatus: 403,
          providerCode: "sensitive_acl_code",
          requestId: "provider-operation-403",
        },
      }),
    )
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    const response = await transport.handleRequest(c) ?? new Response(null, { status: 204 })
    response.headers.set("x-servicenow-request-id", "sn-request-provider-error-123")
    return response
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) }
}

function standaloneConnection(
  url: string,
  authType: "none" | "apikey" | "oauth" = "none",
  apiKey: string | null = null,
  accessToken: string | null = null,
): ExternalMcpConnectionRow {
  const now = new Date()
  return {
    id: createDenTypeId("externalMcpConnection"),
    organizationId: createDenTypeId("organization"),
    name: "Standalone Slack",
    url,
    authType,
    credentialMode: "shared",
    apiKey,
    accessToken,
    refreshToken: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    connectedAt: null,
    createdByOrgMembershipId: createDenTypeId("member"),
    createdAt: now,
    updatedAt: now,
  }
}

async function seedOrganization(label: string): Promise<SeededOrganization> {
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: `${label} User`,
    email: `${label}+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: `${label} Org`,
    slug: `${label}-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "member",
  })
  return { organizationId, memberId }
}

async function createGrantedConnection(seed: SeededOrganization, input: ConnectionInput) {
  return createExternalMcpConnection({
    organizationId: seed.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey,
    createdByOrgMembershipId: seed.memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
}

async function expectConnectionListed(seed: SeededOrganization, connectionId: DenTypeId<"externalMcpConnection">) {
  const connections = await listUsableExternalMcpConnections({
    organizationId: seed.organizationId,
    orgMembershipId: seed.memberId,
    teamIds: [],
  })
  expect(connections.map((connection) => connection.id)).toContain(connectionId)
}

function search(seed: SeededOrganization, query: string) {
  return searchExternalCapabilities({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    query,
    redirectUriBase,
    limit: 10,
  })
}

function toolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name).sort()
}

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [dbMod, schemaMod, clientMod, connectionsMod, capabilitiesMod, envMod] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("../src/capability-sources/external-mcp-client.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/mcp/external-capabilities.js"),
    import("../src/env.js"),
  ])
  // Another co-run test file's static src import may have parsed env.ts before
  // this file's env seeding ran. buildTransport reads env.allowPrivateMcpUrls
  // at call time, so flipping it on the live object keeps the SSRF guard from
  // blocking this file's 127.0.0.1 fake servers regardless of load order.
  envMod.env.allowPrivateMcpUrls = true
  db = dbMod.db
  schema = schemaMod
  listExternalMcpTools = clientMod.listExternalMcpTools
  createExternalMcpConnection = connectionsMod.createExternalMcpConnection
  getExternalMcpConnection = connectionsMod.getExternalMcpConnection
  listUsableExternalMcpConnections = connectionsMod.listUsableExternalMcpConnections
  saveExternalMcpTokens = connectionsMod.saveExternalMcpTokens
  searchExternalCapabilities = capabilitiesMod.searchExternalCapabilities
  executeExternalCapability = capabilitiesMod.executeExternalCapability
  slackServer = startFakeMcpServer("fake-slack", slackTools)
  authedSlackServer = startFakeMcpServer("fake-authed-slack", slackTools, "valid-key")
  notionServer = startFakeMcpServer("fake-notion", notionTools)
  refreshErrorServer = startErrorMcpServer("Invalid refresh token")
  providerErrorServer = startProviderErrorMcpServer()
  needleServer = startFakeMcpServer("fake-needle", [{
    name: "needle-only-tool",
    description: "The only catalog entry matching the coverage test keyword.",
  }])
})

afterAll(() => {
  slackServer?.stop()
  authedSlackServer?.stop()
  notionServer?.stop()
  refreshErrorServer?.stop()
  providerErrorServer?.stop()
  needleServer?.stop()
  mock.restore()
})

test("fake MCP server helper lists tools with the external MCP client", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const tools = await listExternalMcpTools(standaloneConnection(slackServer.url), `${redirectUriBase}/callback`)
  expect(toolNames(tools)).toEqual(toolNames(slackTools))
})

test("control-healthy: Connections list and search_capabilities both see Slack tools", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const seed = await seedOrganization("control-healthy")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "none",
    credentialMode: "shared",
    url: slackServer.url,
  })

  await expectConnectionListed(seed, connection.id)
  const matches = await search(seed, "slack")
  expect(toolNames(matches)).toEqual(slackTools.map((tool) => `mcp:${connection.id}:${tool.name}`).sort())
  expect(matches.length).toBe(5)
  for (const match of matches) {
    expect(match.score).toBeGreaterThanOrEqual(7)
  }
  if (process.env.OPENWORK_EVAL_VERBOSE === "1") {
    console.log("E2E_HEALTHY_DISCOVERY", JSON.stringify({ connectionName: "Slack", toolCount: matches.length, status: "available" }))
  }
})

test("shared-oauth-never-connected: Connections list sees Slack and search returns needs_connection", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const seed = await seedOrganization("shared-oauth-never-connected")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "oauth",
    credentialMode: "shared",
    url: slackServer.url,
  })

  await expectConnectionListed(seed, connection.id)
  const matches = await search(seed, "slack")
  expect(matches.length).toBe(1)
  expect(matches[0]?.name).toBe(`mcp:${connection.id}:*`)
  expect(matches[0]?.kind).toBe("connection_status")
  expect(matches[0]?.status).toBe("needs_connection")
  expect(matches[0]?.score).toBeGreaterThanOrEqual(7)
  expect(matches[0]?.hint).toContain("admin")
  expect(matches[0]?.hint).toContain("Slack")
  expect(matches[0]?.connectionStatus).toMatchObject({
    layer: "downstream_provider",
    connectionName: "Slack",
    credentialMode: "shared",
    state: "needs_connection",
    actor: "organization_admin",
    action: {
      type: "connect",
      surface: "openwork_organization_connections",
      retry: "search_capabilities",
    },
  })
})

test("status-row execute returns a clean needs_connection error", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const seed = await seedOrganization("execute-status-row")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "oauth",
    credentialMode: "shared",
    url: slackServer.url,
  })

  const result = await executeExternalCapability({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    connectionId: connection.id,
    toolName: "*",
    args: {},
    redirectUriBase,
  })
  if (result.ok) throw new Error("Status row unexpectedly executed")
  expect(result.error).toBe("needs_connection")
  expect(result.message).toContain("Slack")
})

test("dead-url: Connections list sees Slack and search returns an error status", async () => {
  const seed = await seedOrganization("dead-url")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "none",
    credentialMode: "shared",
    url: "http://127.0.0.1:9/mcp",
  })

  await expectConnectionListed(seed, connection.id)
  const matches = await search(seed, "slack")
  expect(matches.length).toBe(1)
  expect(matches[0]?.name).toBe(`mcp:${connection.id}:*`)
  expect(matches[0]?.status).toBe("error")
  expect(matches[0]?.connectionStatus).toMatchObject({
    state: "provider_error",
    errorCode: "provider_error",
    actor: "network_admin",
    action: { type: "fix_network", surface: "network_infrastructure" },
  })
  expect(matches[0]?.hint).toContain("inspect")
})

test("dead-url execution returns a structured connection diagnostic instead of throwing", async () => {
  const seed = await seedOrganization("dead-url-execute")
  const connection = await createGrantedConnection(seed, {
    name: "Ticketing",
    authType: "none",
    credentialMode: "shared",
    url: "http://127.0.0.1:9/mcp",
  })

  const result = await executeExternalCapability({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    connectionId: connection.id,
    toolName: "lookup_incidents",
    args: {},
    redirectUriBase,
  })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("Dead MCP execution unexpectedly succeeded")
  expect(result).toMatchObject({
    error: "connection_failed",
    actionOwner: "network_admin",
    diagnostic: {
      phase: "NETWORK_TCP",
      category: "network_failure",
      code: "MCP_ECONNREFUSED",
      actionOwner: "network_admin",
    },
  })
  expect(result.message).toContain("Diagnostic reference")
  if (!result.ok) expect(result.operatorAction).toBe(result.diagnostic?.operatorAction)
})

test("shared invalid_grant recovery cannot reuse the cleared in-memory refresh token", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")
  const { ExternalMcpOAuthProvider } = await import("../src/capability-sources/external-mcp-client.js")
  const { ExternalMcpDiagnosticTracker } = await import("../src/capability-sources/external-mcp-diagnostics.js")
  const seed = await seedOrganization("shared-invalid-grant")
  const connection = await createGrantedConnection(seed, {
    name: "Shared OAuth",
    authType: "oauth",
    credentialMode: "shared",
    url: slackServer.url,
  })
  await saveExternalMcpTokens({
    connectionId: connection.id,
    accessToken: "stale-access-token",
    refreshToken: "revoked-refresh-token",
  })
  const connected = await getExternalMcpConnection({
    organizationId: seed.organizationId,
    connectionId: connection.id,
  })
  if (!connected) throw new Error("Shared OAuth connection was not found")
  const provider = new ExternalMcpOAuthProvider(
    connected,
    `${redirectUriBase}/callback`,
    "signed-state",
    undefined,
    new ExternalMcpDiagnosticTracker("req_shared_invalid_grant"),
  )

  expect(await provider.tokens()).toMatchObject({ refresh_token: "revoked-refresh-token" })
  await provider.invalidateCredentials("tokens")
  expect(await provider.tokens()).toBeUndefined()
  expect(await getExternalMcpConnection({
    organizationId: seed.organizationId,
    connectionId: connection.id,
  })).toMatchObject({ accessToken: null, refreshToken: null })
})

test("per-member OAuth reads JSON scopes returned as text by MySQL", async () => {
  const { ExternalMcpOAuthProvider } = await import("../src/capability-sources/external-mcp-client.js")
  const { ExternalMcpDiagnosticTracker } = await import("../src/capability-sources/external-mcp-diagnostics.js")
  const seed = await seedOrganization("per-member-json-scopes")
  const connection = await createGrantedConnection(seed, {
    name: "Per-member OAuth",
    authType: "oauth",
    credentialMode: "per_member",
    url: "https://mcp.example.test/mcp",
  })
  await db.insert(schema.ConnectedAccountTable).values({
    id: createDenTypeId("connectedAccount"),
    organizationId: seed.organizationId,
    orgMembershipId: seed.memberId,
    providerId: connection.id,
    accessToken: "member-access-token",
    tokenType: "Bearer",
    scopes: ["tools.read", "tools.write"],
  })
  const provider = new ExternalMcpOAuthProvider(
    connection,
    `${redirectUriBase}/callback`,
    "signed-state",
    { orgMembershipId: seed.memberId },
    new ExternalMcpDiagnosticTracker("req_per_member_json_scopes"),
  )

  expect(await provider.tokens()).toMatchObject({
    access_token: "member-access-token",
    scope: "tools.read tools.write",
  })
})

test("the 16-connection fanout reports incomplete coverage when the only match is connection 17", async () => {
  if (!slackServer || !needleServer) throw new Error("Coverage MCP servers were not started")
  const { externalMcpSearchCoverageHint } = await import("../src/mcp/external-capabilities.js")
  const seed = await seedOrganization("fanout-coverage")
  for (let index = 0; index < 17; index += 1) {
    await createGrantedConnection(seed, {
      name: `Provider ${String(index).padStart(2, "0")}`,
      authType: "none",
      credentialMode: "shared",
      url: index === 16 ? needleServer.url : slackServer.url,
    })
  }
  let coverage: Parameters<typeof externalMcpSearchCoverageHint>[0] | undefined
  const matches = await searchExternalCapabilities({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    query: "needle",
    redirectUriBase,
    limit: 10,
    reportCoverage: (reported) => {
      coverage = reported
    },
  })

  expect(matches).toEqual([])
  expect(coverage).toEqual({ eligibleConnections: 17, probedConnections: 16, truncated: true })
  if (!coverage) throw new Error("External MCP search did not report coverage")
  expect(externalMcpSearchCoverageHint(coverage)).toContain("16 of 17")
  expect(externalMcpSearchCoverageHint(coverage)).toContain("Results may be incomplete")
})

test("MCP tool isError is surfaced as a provider failure, not transport success", async () => {
  if (!providerErrorServer) throw new Error("Provider-error MCP server was not started")
  const seed = await seedOrganization("provider-is-error")
  const connection = await createGrantedConnection(seed, {
    name: "ServiceNow",
    authType: "none",
    credentialMode: "shared",
    url: providerErrorServer.url,
  })
  const result = await executeExternalCapability({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    connectionId: connection.id,
    toolName: "create_change",
    args: {},
    redirectUriBase,
  })
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("Provider isError unexpectedly returned success")
  expect(result).toMatchObject({
    error: "provider_error",
    diagnostic: {
      phase: "PROVIDER_EXECUTION",
      category: "provider_tool_error",
      code: "MCP_PROVIDER_TOOL_ERROR",
      highestPassed: "protocol_ready",
      providerRequestId: "sn-request-provider-error-123",
      httpStatus: 200,
    },
  })
  expect(result.message).not.toContain("internal detail")
})

test("structured provider denial keeps connection health separate and names the provider admin", async () => {
  if (!providerErrorServer) throw new Error("Provider-error MCP server was not started")
  const seed = await seedOrganization("provider-policy-denied")
  const connection = await createGrantedConnection(seed, {
    name: "ServiceNow",
    authType: "none",
    credentialMode: "shared",
    url: providerErrorServer.url,
  })
  const result = await executeExternalCapability({
    organizationId: seed.organizationId,
    member: { orgMembershipId: seed.memberId, teamIds: [] },
    connectionId: connection.id,
    toolName: "read_denied_change",
    args: {},
    redirectUriBase,
  })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("Provider policy denial unexpectedly returned success")
  expect(result).toMatchObject({
    error: "provider_error",
    actionOwner: "provider_admin",
    diagnostic: {
      phase: "PROVIDER_AUTHORIZATION",
      category: "provider_policy_denied",
      code: "MCP_PROVIDER_HTTP_403",
      highestPassed: "protocol_ready",
      actionOwner: "provider_admin",
      providerRequestId: "provider-operation-403",
    },
  })
  expect(result.message).toContain("Diagnostic reference")
  expect(JSON.stringify(result)).not.toContain("Sensitive provider policy detail")
  expect(JSON.stringify(result)).not.toContain("sensitive_acl_code")
})

test("stale-apikey-looks-connected: stored API key looks connected and search returns an error status", async () => {
  if (!authedSlackServer) throw new Error("Authenticated Slack MCP server was not started")

  const seed = await seedOrganization("stale-apikey-looks-connected")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "apikey",
    credentialMode: "shared",
    url: authedSlackServer.url,
    apiKey: "revoked-key",
  })

  await expectConnectionListed(seed, connection.id)
  // Mirrors isConnectionConnected at routes/org/mcp-connections.ts:178, which makes desktop/dashboard show "connected".
  expect(Boolean(connection.apiKey)).toBe(true)

  const tools = await listExternalMcpTools(
    standaloneConnection(authedSlackServer.url, "apikey", "valid-key"),
    `${redirectUriBase}/callback`,
  )
  expect(toolNames(tools)).toEqual(toolNames(slackTools))

  const matches = await search(seed, "slack")
  expect(matches.length).toBe(1)
  expect(matches[0]?.name).toBe(`mcp:${connection.id}:*`)
  expect(matches[0]?.status).toBe("error")
  expect(matches[0]?.connectionStatus).toMatchObject({
    state: "reauth_required",
    errorCode: "unauthorized",
    actor: "organization_admin",
    action: { type: "update_credentials" },
  })
})

test("stale-oauth-token-looks-connected: stored OAuth token looks connected and search returns an error status", async () => {
  if (!authedSlackServer) throw new Error("Authenticated Slack MCP server was not started")

  const seed = await seedOrganization("stale-oauth-token-looks-connected")
  const connection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "oauth",
    credentialMode: "shared",
    url: authedSlackServer.url,
  })
  await saveExternalMcpTokens({ connectionId: connection.id, accessToken: "expired-token" })
  const connectedRow = await getExternalMcpConnection({
    organizationId: seed.organizationId,
    connectionId: connection.id,
  })
  if (!connectedRow) throw new Error("Connected OAuth row was not found")

  await expectConnectionListed(seed, connection.id)
  // Mirrors isConnectionConnected at routes/org/mcp-connections.ts:178, which makes desktop/dashboard show "connected".
  expect(Boolean(connectedRow.accessToken)).toBe(true)
  const matches = await search(seed, "slack")
  expect(matches.length).toBe(1)
  expect(matches[0]?.name).toBe(`mcp:${connection.id}:*`)
  expect(matches[0]?.status).toBe("error")
})

test("JSON-RPC initialize errors are not mislabeled as OAuth refresh failures", async () => {
  if (!refreshErrorServer) throw new Error("Refresh-error MCP server was not started")

  const seed = await seedOrganization("invalid-refresh-token")
  const connection = await createGrantedConnection(seed, {
    name: "Knowledge Hub",
    authType: "oauth",
    credentialMode: "shared",
    url: refreshErrorServer.url,
  })
  await saveExternalMcpTokens({ connectionId: connection.id, accessToken: "stale-token", refreshToken: "stale-refresh" })

  const matches = await search(seed, "knowledge hub")

  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({
    kind: "connection_status",
    status: "error",
    connectionStatus: {
      layer: "mcp_connection",
      connectionName: "Knowledge Hub",
      authType: "oauth",
      state: "provider_error",
      errorCode: "provider_error",
      actor: "provider_admin",
      action: {
        type: "fix_provider",
        surface: "provider_admin_console",
        retry: "search_capabilities",
      },
      diagnostic: {
        phase: "MCP_INITIALIZE",
        category: "mcp_protocol_failure",
        code: "MCP_MCP_INITIALIZE",
        highestPassed: "reachable",
        jsonRpcCode: -32603,
      },
    },
  })
  expect(matches[0]?.hint).toContain("Diagnostic reference")
  expect(matches[0]?.hint).not.toContain("Reconnect")
  if (process.env.OPENWORK_EVAL_VERBOSE === "1") {
    console.log("E2E_CONNECTION_STATUS", JSON.stringify(matches[0]?.connectionStatus))
  }
})

test("repairing a connector credential makes its live tools discoverable on retry", async () => {
  if (!authedSlackServer) throw new Error("Authenticated Slack MCP server was not started")

  const seed = await seedOrganization("repair-and-retry")
  const connection = await createGrantedConnection(seed, {
    name: "Team Chat",
    authType: "oauth",
    credentialMode: "shared",
    url: authedSlackServer.url,
  })
  await saveExternalMcpTokens({ connectionId: connection.id, accessToken: "expired-token" })

  const beforeRepair = await search(seed, "team chat")
  expect(beforeRepair[0]?.kind).toBe("connection_status")
  expect(beforeRepair[0]?.status).toBe("error")

  await saveExternalMcpTokens({ connectionId: connection.id, accessToken: "valid-key" })
  const afterRepair = await search(seed, "team chat")

  expect(afterRepair.some((match) => match.kind === "connection_status")).toBe(false)
  expect(toolNames(afterRepair)).toEqual(slackTools.map((tool) => `mcp:${connection.id}:${tool.name}`).sort())
  if (process.env.OPENWORK_EVAL_VERBOSE === "1") {
    console.log("E2E_RECOVERED_DISCOVERY", JSON.stringify({ connectionName: "Team Chat", toolCount: afterRepair.length, status: "available" }))
  }
})

test("per-member-name-mismatch: needs_connection only appears when query matches connection name", async () => {
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const seed = await seedOrganization("per-member-name-mismatch")
  const connection = await createGrantedConnection(seed, {
    name: "Team Chat",
    authType: "oauth",
    credentialMode: "per_member",
    url: slackServer.url,
  })

  await expectConnectionListed(seed, connection.id)
  expect(await search(seed, "slack")).toEqual([])

  const matches = await search(seed, "team chat")
  expect(matches.length).toBe(1)
  expect(matches[0]?.name).toBe(`mcp:${connection.id}:*`)
  expect(matches[0]?.status).toBe("needs_connection")
})

test("user-transcript-repro: Slack connection status ranks above Notion's summary-only Slack hit", async () => {
  if (!notionServer) throw new Error("Notion MCP server was not started")
  if (!slackServer) throw new Error("Slack MCP server was not started")

  const seed = await seedOrganization("user-transcript-repro")
  const notionConnection = await createGrantedConnection(seed, {
    name: "Notion",
    authType: "none",
    credentialMode: "shared",
    url: notionServer.url,
  })
  const slackConnection = await createGrantedConnection(seed, {
    name: "Slack",
    authType: "oauth",
    credentialMode: "shared",
    url: slackServer.url,
  })

  await expectConnectionListed(seed, notionConnection.id)
  await expectConnectionListed(seed, slackConnection.id)
  const matches = await search(seed, "slack")
  expect(matches.length).toBe(2)
  expect(matches[0]?.name).toBe(`mcp:${slackConnection.id}:*`)
  expect(matches[0]?.status).toBe("needs_connection")
  expect(matches[0]?.score).toBeGreaterThanOrEqual(7)
  expect(matches[1]?.name).toBe(`mcp:${notionConnection.id}:notion-search`)
  expect(matches[1]?.score).toBe(2)
})
