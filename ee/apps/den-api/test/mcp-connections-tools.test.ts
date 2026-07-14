import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_mcp_tools"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection

const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const otherMemberId = createDenTypeId("member")
let connectionId: DenTypeId<"externalMcpConnection">
let disconnectedConnectionId: DenTypeId<"externalMcpConnection">
let perMemberConnectionId: DenTypeId<"externalMcpConnection">
let otherConnectionId: DenTypeId<"externalMcpConnection">
let failingConnectionId: DenTypeId<"externalMcpConnection">
let fakeServer: ReturnType<typeof Bun.serve> | undefined
let errorServer: ReturnType<typeof Bun.serve> | undefined
const observedMethods: string[] = []
const observedAuthorization: Array<string | null> = []

beforeAll(async () => {
  mock.restore()
  const fakeMcp = new Hono()
  fakeMcp.all("/mcp", async (c) => {
    const payload: unknown = await c.req.raw.clone().json().catch(() => null)
    if (payload && typeof payload === "object" && "method" in payload && typeof payload.method === "string") {
      observedMethods.push(payload.method)
      observedAuthorization.push(c.req.header("authorization") ?? null)
    }
    const server = new McpServer({ name: "catalog-proof", version: "1.0.0" })
    server.registerTool(
      "search_incidents",
      {
        title: "Search incidents",
        description: "Search incidents by query and optional status.",
        inputSchema: z.object({ query: z.string(), status: z.string().optional() }),
        outputSchema: z.object({ resultCount: z.number() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({ content: [{ type: "text", text: "not called" }] }),
    )
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
  fakeServer = Bun.serve({ port: 0, fetch: fakeMcp.fetch })

  const errorMcp = new Hono()
  errorMcp.all("/mcp", async (c) => {
    const payload: unknown = await c.req.raw.json().catch(() => null)
    const id = payload && typeof payload === "object" && "id" in payload ? payload.id : null
    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "provider-catalog-secret must never leave diagnostics" },
    })
  })
  errorServer = Bun.serve({ port: 0, fetch: errorMcp.fetch })

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL ?? "",
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, connectionsMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  createExternalMcpConnection = connectionsMod.createExternalMcpConnection

  await db.insert(schema.AuthUserTable).values([
    { id: adminUserId, name: "Catalog Admin", email: `catalog-admin+${adminUserId}@test.local` },
    { id: memberUserId, name: "Catalog Member", email: `catalog-member+${memberUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "Catalog Org", slug: `catalog-${organizationId}` },
    { id: otherOrganizationId, name: "Other Catalog Org", slug: `catalog-${otherOrganizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
    { id: otherMemberId, organizationId: otherOrganizationId, userId: adminUserId, role: "admin" },
  ])

  const url = `http://127.0.0.1:${fakeServer.port}/mcp`
  const connected = await createExternalMcpConnection({
    organizationId,
    name: "Incident MCP",
    url,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  connectionId = connected.id
  await db.update(schema.ExternalMcpConnectionTable)
    .set({ connectedAt: new Date() })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId))

  disconnectedConnectionId = (await createExternalMcpConnection({
    organizationId,
    name: "Disconnected MCP",
    url,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })).id

  perMemberConnectionId = (await createExternalMcpConnection({
    organizationId,
    name: "Personal Incident MCP",
    url,
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })).id
  await db.insert(schema.ConnectedAccountTable).values({
    id: createDenTypeId("connectedAccount"),
    organizationId,
    orgMembershipId: adminMemberId,
    providerId: perMemberConnectionId,
    accessToken: "member-catalog-token",
    tokenType: "Bearer",
  })

  otherConnectionId = (await createExternalMcpConnection({
    organizationId: otherOrganizationId,
    name: "Other MCP",
    url,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: otherMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })).id

  failingConnectionId = (await createExternalMcpConnection({
    organizationId,
    name: "Failing Catalog MCP",
    url: `http://127.0.0.1:${errorServer.port}/mcp`,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })).id
  await db.update(schema.ExternalMcpConnectionTable)
    .set({ connectedAt: new Date() })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, failingConnectionId))
})

afterAll(async () => {
  fakeServer?.stop(true)
  errorServer?.stop(true)
  if (!db || !schema || !drizzle) return
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.inArray(
    schema.ExternalMcpConnectionAccessGrantTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.ConnectedAccountTable).where(drizzle.inArray(
    schema.ConnectedAccountTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.inArray(
    schema.ExternalMcpConnectionTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, otherOrganizationId]))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [adminUserId, memberUserId]))
  mock.restore()
})

function request(id: string, userId = adminUserId) {
  return app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${id}/tools`, {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
    },
  }))
}

test("admin inspects a live Den-managed MCP catalog without calling a tool", async () => {
  observedMethods.length = 0
  const response = await request(connectionId)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    tools: [{
      name: "search_incidents",
      title: "Search incidents",
      description: "Search incidents by query and optional status.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, status: { type: "string" } },
        required: ["query"],
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      outputSchema: {
        type: "object",
        properties: { resultCount: { type: "number" } },
        required: ["resultCount"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }],
  })
  expect(observedMethods).toContain("tools/list")
  expect(observedMethods).not.toContain("tools/call")
})

test("a validated no-auth MCP is immediately connected and inspectable", async () => {
  observedMethods.length = 0
  const response = await app.fetch(new Request("http://den-api.local/v1/mcp-connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId: adminUserId, organizationId }),
    },
    body: JSON.stringify({
      name: "Fresh no-auth MCP",
      url: `http://127.0.0.1:${fakeServer?.port}/mcp`,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  }))
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ connected: true, connectedForMe: true })
  if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string") {
    throw new Error("created no-auth connection response did not include an id")
  }

  const catalogResponse = await request(body.id)
  expect(catalogResponse.status).toBe(200)
  expect(observedMethods).toContain("initialize")
  expect(observedMethods).toContain("tools/list")
  expect(observedMethods).not.toContain("tools/call")
})

test("catalog inspection requires a connected credential", async () => {
  const response = await request(disconnectedConnectionId)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: "connection_not_ready",
    message: "Connect this MCP before inspecting its tools.",
  })
})

test("per-member catalog inspection uses only the calling admin's credential", async () => {
  observedAuthorization.length = 0
  const response = await request(perMemberConnectionId)
  expect(response.status).toBe(200)
  expect(observedAuthorization).toContain("Bearer member-catalog-token")
})

test("catalog inspection is tenant scoped", async () => {
  const response = await request(otherConnectionId)
  expect(response.status).toBe(404)
})

test("catalog inspection is admin only", async () => {
  const response = await request(connectionId, memberUserId)
  expect(response.status).toBe(403)
})

test("catalog failures return a structured diagnostic without provider secrets", async () => {
  const response = await request(failingConnectionId)
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ error: "tool_catalog_failed" })
  expect(JSON.stringify(body)).not.toContain("provider-catalog-secret")
  if (!body || typeof body !== "object" || !("diagnostic" in body) || !body.diagnostic || typeof body.diagnostic !== "object") {
    throw new Error("catalog failure response did not include a diagnostic")
  }
  expect("referenceId" in body.diagnostic && typeof body.diagnostic.referenceId === "string").toBe(true)
})
