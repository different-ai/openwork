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
})

afterAll(() => {
  slackServer?.stop()
  authedSlackServer?.stop()
  notionServer?.stop()
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
  expect(matches[0]?.status).toBe("needs_connection")
  expect(matches[0]?.score).toBeGreaterThanOrEqual(7)
  expect(matches[0]?.hint).toContain("admin")
  expect(matches[0]?.hint).toContain("Slack")
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
  expect(matches[0]?.summary).toContain("not responding")
  expect(matches[0]?.hint).toContain("Reconnect")
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
