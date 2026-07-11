import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { z } from "zod"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_mcp_diagnostics"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

seedRequiredEnv()

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let diagnostics: typeof import("../src/capability-sources/external-mcp-diagnostics.js")
let genericOAuth: typeof import("../src/capability-sources/generic-oauth.js")
let externalMcpConnections: typeof import("../src/capability-sources/external-mcp-connections.js")
let externalMcpClient: typeof import("../src/capability-sources/external-mcp-client.js")
let externalMcpDiagnosticRunner: typeof import("../src/capability-sources/external-mcp-diagnostic-runner.js")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let denEnv: typeof import("../src/env.js").env
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection
let fakeServer: ReturnType<typeof Bun.serve> | undefined

const userId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const otherUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const otherAdminMemberId = createDenTypeId("member")
const adminSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const otherSessionId = createDenTypeId("session")
const adminToken = `mcp-diagnostic-admin-${adminSessionId}`
const memberToken = `mcp-diagnostic-member-${memberSessionId}`
const otherToken = `mcp-diagnostic-other-${otherSessionId}`
let connectionId: DenTypeId<"externalMcpConnection"> | undefined

function startFakeMcpServer() {
  const hono = new Hono()
  hono.post("/mcp-2025-03-26", async (c) => {
    const payload = await c.req.json() as { jsonrpc?: string; id?: string | number; method?: string }
    if (payload.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-2025-03-26-fixture", version: "1.0.0" },
        },
      })
    }
    if (payload.method === "notifications/initialized") return c.body(null, 202)
    if (payload.method === "tools/list") {
      return c.json({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } })
    }
    return c.json({
      jsonrpc: "2.0",
      id: payload.id ?? null,
      error: { code: -32601, message: "Method not found" },
    }, 404)
  })
  hono.all("/mcp", async (c) => {
    const server = new McpServer({ name: "diagnostic-fixture", version: "1.0.0" })
    server.registerTool(
      "lookup_incidents",
      {
        description: "Returns a synthetic incident.",
        inputSchema: z.object({ limit: z.number().int().positive().optional() }),
      },
      async () => ({ content: [{ type: "text", text: "Synthetic incident" }] }),
    )
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
  return Bun.serve({ port: 0, fetch: hono.fetch })
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, diagnosticsMod, connectionsMod, externalMcpClientMod, runnerMod, genericOAuthMod, oauthCredentialsMod, envMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/external-mcp-diagnostics.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/external-mcp-client.js"),
    import("../src/capability-sources/external-mcp-diagnostic-runner.js"),
    import("../src/capability-sources/generic-oauth.js"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/env.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  diagnostics = diagnosticsMod
  externalMcpConnections = connectionsMod
  externalMcpClient = externalMcpClientMod
  externalMcpDiagnosticRunner = runnerMod
  createExternalMcpConnection = connectionsMod.createExternalMcpConnection
  genericOAuth = genericOAuthMod
  oauthCredentials = oauthCredentialsMod
  denEnv = envMod.env
  envMod.env.allowPrivateMcpUrls = true
  fakeServer = startFakeMcpServer()

  await db.insert(schema.AuthUserTable).values([
    { id: userId, name: "Diagnostic Admin", email: `diagnostic-admin+${userId}@test.local` },
    { id: memberUserId, name: "Diagnostic Member", email: `diagnostic-member+${memberUserId}@test.local` },
    { id: otherUserId, name: "Other Admin", email: `diagnostic-other+${otherUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "Diagnostic Org", slug: `diagnostic-${organizationId}` },
    { id: otherOrganizationId, name: "Other Diagnostic Org", slug: `diagnostic-${otherOrganizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId, role: "owner" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
    { id: otherAdminMemberId, organizationId: otherOrganizationId, userId: otherUserId, role: "owner" },
  ])
  await db.insert(schema.AuthSessionTable).values([
    { id: adminSessionId, userId, activeOrganizationId: organizationId, token: adminToken, expiresAt: new Date(Date.now() + 86_400_000) },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberToken, expiresAt: new Date(Date.now() + 86_400_000) },
    { id: otherSessionId, userId: otherUserId, activeOrganizationId: otherOrganizationId, token: otherToken, expiresAt: new Date(Date.now() + 86_400_000) },
  ])
  const connection = await createExternalMcpConnection({
    organizationId,
    name: "ServiceNow diagnostic fixture",
    url: `http://127.0.0.1:${fakeServer.port}/mcp?token=must-not-appear`,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  connectionId = connection.id
})

afterAll(async () => {
  fakeServer?.stop(true)
  await db.delete(schema.ExternalMcpOAuthPendingGrantTable).where(drizzle.eq(schema.ExternalMcpOAuthPendingGrantTable.organizationId, organizationId))
  await db.delete(schema.McpDiagnosticEventTable).where(drizzle.eq(schema.McpDiagnosticEventTable.organizationId, organizationId))
  await db.delete(schema.McpDiagnosticAttemptTable).where(drizzle.eq(schema.McpDiagnosticAttemptTable.organizationId, organizationId))
  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.id, [adminSessionId, memberSessionId, otherSessionId]))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.id, [adminMemberId, memberId, otherAdminMemberId]))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, otherOrganizationId]))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, memberUserId, otherUserId]))
  mock.restore()
})

function requireConnectionId() {
  if (!connectionId) throw new Error("Diagnostic connection was not created")
  return connectionId
}

async function createOAuthDiagnosticConnection(label: string) {
  return createExternalMcpConnection({
    organizationId,
    name: `${label} ${crypto.randomUUID()}`,
    url: "https://mcp.enterprise.example.test/mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
}

async function markAttemptWaiting(input: {
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  message?: string
}) {
  await diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId: input.attemptId,
    phase: "AUTH_USER_OR_WORKLOAD",
    outcome: "waiting",
    healthLevel: "reachable",
    messageSafe: input.message ?? "Waiting for provider authorization.",
    actionOwner: "member",
    operatorAction: "complete_provider_authorization",
    attemptStatus: "waiting_for_authorization",
  })
}

async function waitForTerminalAttempt(attemptId: DenTypeId<"mcpDiagnosticAttempt">, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
    if (snapshot && ["succeeded", "failed", "expired"].includes(snapshot.attempt.status)) return snapshot
    await Bun.sleep(20)
  }
  throw new Error(`Diagnostic attempt ${attemptId} did not complete.`)
}

function request(token: string, path: string, method = "GET", headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(headers)
  requestHeaders.set("authorization", `Bearer ${token}`)
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method,
    headers: requestHeaders,
  }))
}

function parseSseData(text: string): unknown[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
      if (!data) return []
      return [JSON.parse(data)]
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

test("Turbo propagates the public Den API URL into local runtime tasks", async () => {
  const turboConfig = await Bun.file(new URL("../../../../turbo.json", import.meta.url)).json() as {
    globalEnv?: unknown
  }
  expect(Array.isArray(turboConfig.globalEnv)).toBe(true)
  expect(turboConfig.globalEnv).toContain("DEN_API_PUBLIC_URL")
})

test("persistent diagnostics allocate monotonic sequences, health, and immutable first failure", async () => {
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  expect(attemptId).toStartWith("mda_")

  await Promise.all([
    diagnostics.appendMcpDiagnosticEvent({
      organizationId,
      attemptId,
      phase: "HTTP_ROUTING",
      outcome: "passed",
      healthLevel: "reachable",
      messageSafe: "Endpoint reached.",
    }),
    diagnostics.appendMcpDiagnosticEvent({
      organizationId,
      attemptId,
      phase: "MCP_INITIALIZE",
      outcome: "passed",
      healthLevel: "protocol_ready",
      messageSafe: "Initialized.",
    }),
    diagnostics.appendMcpDiagnosticEvent({
      organizationId,
      attemptId,
      phase: "NETWORK_TLS",
      outcome: "passed",
      healthLevel: "configured",
      messageSafe: "TLS passed.",
    }),
  ])
  await diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId,
    phase: "MCP_VERSION",
    outcome: "failed",
    healthLevel: "authorized",
    messageSafe: "Version mismatch.",
    category: "mcp_version",
    operatorAction: "align_versions",
    attemptStatus: "failed",
  })
  await expect(diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId,
    phase: "MCP_TOOL_DISCOVERY",
    outcome: "failed",
    healthLevel: "protocol_ready",
    messageSafe: "Later catalog symptom.",
    category: "mcp_catalog",
    operatorAction: "inspect_catalog",
    attemptStatus: "failed",
  })).rejects.toThrow("already complete")

  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
  expect(snapshot?.attempt.highestHealthLevel).toBe("protocol_ready")
  expect(snapshot?.attempt.firstFailedPhase).toBe("MCP_VERSION")
  expect(snapshot?.attempt.firstFailureCategory).toBe("mcp_version")
})

test("event persistence treats a removed diagnostic attempt as gracefully closed", async () => {
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  await db
    .delete(schema.McpDiagnosticAttemptTable)
    .where(drizzle.eq(schema.McpDiagnosticAttemptTable.id, attemptId))

  await expect(diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId,
    phase: "HTTP_ROUTING",
    outcome: "passed",
    healthLevel: "reachable",
    messageSafe: "This late event should close without an opaque persistence error.",
  })).rejects.toMatchObject({ name: "McpDiagnosticAttemptClosedError" })
})

test("safe evidence strips query credentials and templates enterprise server identifiers", () => {
  const evidence = diagnostics.safeMcpDiagnosticEvidence({
    url: "https://example.service-now.com/sncapps/mcp-server/mcp/customer-production?code=secret&token=secret",
    method: "POST",
    status: 401,
  })
  expect(evidence).toEqual({
    origin: "https://example.service-now.com",
    path: "/sncapps/mcp-server/mcp/{server}",
    method: "POST",
    status: 401,
    detailsRedacted: true,
  })
  expect(JSON.stringify(evidence)).not.toContain("secret")
  expect(JSON.stringify(evidence)).not.toContain("customer-production")

  const generic = diagnostics.safeMcpDiagnosticEvidence({
    url: "https://mcp.example.test/mcp/customer-secret/instances/instance-42?token=secret",
  })
  expect(generic.path).toBe("/mcp/{segment}/{segment}/{segment}")
  expect(JSON.stringify(generic)).not.toContain("customer-secret")
  expect(JSON.stringify(generic)).not.toContain("instance-42")
})

test("post-OAuth wrong-audience failures persist resource validation instead of MCP initialization", async () => {
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const error = externalMcpClient.postAuthorizationResourceValidationError(
    "https://mcp.example.test/mcp?token=must-not-appear",
  )

  expect(externalMcpClient.diagnosticPhaseFromError(error)).toBe("AUTH_RESOURCE_VALIDATION")
  await diagnostics.failMcpDiagnosticAttempt({
    organizationId,
    attemptId,
    phase: externalMcpClient.diagnosticPhaseFromError(error),
    healthLevel: "reachable",
    error,
    evidence: externalMcpClient.diagnosticEvidenceFromError(error),
  })

  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.attempt.status).toBe("failed")
  expect(snapshot?.attempt.firstFailedPhase).toBe("AUTH_RESOURCE_VALIDATION")
  expect(snapshot?.attempt.firstFailureCategory).toBe("oauth_invalid_token")
  expect(snapshot?.attempt.actionOwner).toBe("member")
  expect(JSON.stringify(snapshot)).not.toContain("must-not-appear")
})

test("PKCE grants are state-bound, concurrency-safe, expiring, and one-time", async () => {
  const connection = requireConnectionId()
  const client = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection,
    clientId: `pkce-client-${crypto.randomUUID()}`,
    createdByOrgMembershipId: adminMemberId,
  })
  const stateA = `signed-state-a-${crypto.randomUUID()}`
  const stateB = `signed-state-b-${crypto.randomUUID()}`
  await Promise.all([
    externalMcpConnections.saveExternalMcpOAuthPendingGrant({
      organizationId,
      connectionId: connection,
      orgMembershipId: null,
      signedState: stateA,
      codeVerifier: "verifier-a",
      orgOAuthClientId: client.id,
      clientRevision: client.revision,
    }),
    externalMcpConnections.saveExternalMcpOAuthPendingGrant({
      organizationId,
      connectionId: connection,
      orgMembershipId: null,
      signedState: stateB,
      codeVerifier: "verifier-b",
      orgOAuthClientId: client.id,
      clientRevision: client.revision,
    }),
  ])

  const [verifierB, verifierA] = await Promise.all([
    externalMcpConnections.consumeExternalMcpOAuthPendingGrant({
      organizationId,
      connectionId: connection,
      orgMembershipId: null,
      signedState: stateB,
    }),
    externalMcpConnections.consumeExternalMcpOAuthPendingGrant({
      organizationId,
      connectionId: connection,
      orgMembershipId: null,
      signedState: stateA,
    }),
  ])
  expect([verifierA.codeVerifier, verifierB.codeVerifier]).toEqual(["verifier-a", "verifier-b"])
  expect([verifierA.clientRevision, verifierB.clientRevision]).toEqual([client.revision, client.revision])
  await expect(externalMcpConnections.consumeExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection,
    orgMembershipId: null,
    signedState: stateA,
  })).rejects.toThrow("already consumed")

  const expiredState = `signed-state-expired-${crypto.randomUUID()}`
  const expiredAt = new Date(Date.now() - 11 * 60 * 1000)
  await externalMcpConnections.saveExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection,
    orgMembershipId: null,
    signedState: expiredState,
    codeVerifier: "expired-verifier",
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    now: expiredAt,
  })
  await expect(externalMcpConnections.consumeExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection,
    orgMembershipId: null,
    signedState: expiredState,
  })).rejects.toThrow("expired")
})

test("parallel first-time DCR starts share one client revision and callbacks reject rotation", async () => {
  const connection = await createOAuthDiagnosticConnection("Concurrent DCR")
  const stateA = `dcr-state-a-${crypto.randomUUID()}`
  const stateB = `dcr-state-b-${crypto.randomUUID()}`
  const providerA = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateA,
  )
  const providerB = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateB,
  )

  expect(await providerA.clientInformation()).toBeUndefined()
  const waitingB = providerB.clientInformation()
  await Bun.sleep(10)
  await providerA.saveClientInformation({
    client_id: "dcr-winner-client",
    client_secret: "dcr-winner-secret",
    registration_access_token: "must-never-be-json",
    registration_client_uri: "https://issuer.example.test/register/dcr-winner-client",
  })
  const informationB = await waitingB
  expect(informationB?.client_id).toBe("dcr-winner-client")

  const stored = await oauthCredentials.getOrgOAuthClient(organizationId, connection.id)
  expect(stored?.revision).toBe(1)
  expect(stored?.clientSecret).toBe("dcr-winner-secret")
  expect(JSON.stringify(stored?.extra)).not.toContain("dcr-winner-secret")
  expect(JSON.stringify(stored?.extra)).not.toContain("must-never-be-json")
  expect(JSON.stringify(stored?.extra)).not.toContain("registration_client_uri")

  await Promise.all([
    providerA.saveCodeVerifier("verifier-a"),
    providerB.saveCodeVerifier("verifier-b"),
  ])
  const callbackA = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateA,
    undefined,
    undefined,
    undefined,
    true,
  )
  const callbackB = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateB,
    undefined,
    undefined,
    undefined,
    true,
  )
  expect((await callbackA.clientInformation())?.client_id).toBe("dcr-winner-client")
  expect((await callbackB.clientInformation())?.client_id).toBe("dcr-winner-client")
  expect(await callbackA.codeVerifier()).toBe("verifier-a")
  expect(await callbackB.codeVerifier()).toBe("verifier-b")
  await callbackA.saveTokens({ access_token: "callback-a-token", token_type: "Bearer" })
  await callbackB.saveTokens({ access_token: "callback-b-token", token_type: "Bearer" })

  const stateC = `dcr-state-c-${crypto.randomUUID()}`
  const providerC = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateC,
  )
  expect((await providerC.clientInformation())?.client_id).toBe("dcr-winner-client")
  await providerC.saveCodeVerifier("verifier-c")
  const callbackC = new externalMcpClient.ExternalMcpOAuthProvider(
    connection,
    "https://den.example.test/v1/mcp/callback",
    stateC,
    undefined,
    undefined,
    undefined,
    true,
  )
  expect((await callbackC.clientInformation())?.client_id).toBe("dcr-winner-client")
  expect(await callbackC.codeVerifier()).toBe("verifier-c")

  const rotated = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "rotated-client",
    clientSecret: "rotated-secret",
    createdByOrgMembershipId: adminMemberId,
  })
  expect(rotated.revision).toBe(2)
  await expect(callbackC.clientInformation()).rejects.toThrow("changed after authorization started")
  await expect(callbackC.saveTokens({ access_token: "rotated-callback-must-not-write" })).rejects.toThrow("changed after authorization started")
  expect((await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id }))?.accessToken).toBe("callback-b-token")
})

test("revoked refresh credentials are invalidated for reauthorization without an early durable write", async () => {
  const connection = await createOAuthDiagnosticConnection("Revoked refresh")
  await externalMcpConnections.saveExternalMcpTokens({
    connectionId: connection.id,
    accessToken: "stale-access",
    refreshToken: "revoked-refresh",
    tokenType: "Bearer",
  })
  const stored = await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id })
  if (!stored) throw new Error("Expected stored OAuth connection")
  const provider = new externalMcpClient.ExternalMcpOAuthProvider(
    stored,
    "https://den.example.test/v1/mcp/callback",
    `refresh-reauth-state-${crypto.randomUUID()}`,
  )

  expect(await provider.tokens()).toMatchObject({ access_token: "stale-access", refresh_token: "revoked-refresh" })
  await provider.invalidateCredentials("tokens")
  expect(await provider.tokens()).toBeUndefined()
  expect((await externalMcpConnections.getExternalMcpConnection({
    organizationId,
    connectionId: connection.id,
  }))?.refreshToken).toBe("revoked-refresh")
})

test("callback credential CAS wins before timeout and makes timeout ineligible", async () => {
  const connection = await createOAuthDiagnosticConnection("Callback wins")
  const client = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: `callback-wins-client-${crypto.randomUUID()}`,
    createdByOrgMembershipId: adminMemberId,
  })
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const generation = await diagnostics.reserveMcpDiagnosticAuthorizationGeneration({ organizationId, attemptId })
  await markAttemptWaiting({ attemptId })
  const claimedAt = new Date()
  const lease = await diagnostics.claimMcpDiagnosticAuthorizationCallback({
    organizationId,
    connectionId: connection.id,
    attemptId,
    createdByOrgMembershipId: adminMemberId,
    generation,
    now: claimedAt,
    leaseMs: 50,
  })
  if (!lease) throw new Error("Expected callback lease")
  const signedState = `callback-wins-state-${crypto.randomUUID()}`
  await externalMcpConnections.saveExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    signedState,
    codeVerifier: "callback-wins-verifier",
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticAttemptId: attemptId,
    diagnosticGeneration: generation,
  })

  await externalMcpConnections.saveExternalMcpCallbackTokens({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticFence: { attemptId, generation, leaseId: lease.leaseId },
    pendingGrant: { signedState, diagnosticAttemptId: attemptId, diagnosticGeneration: generation },
    accessToken: "callback-winner-token",
    now: new Date(claimedAt.getTime() + 10),
  })
  const expiry = await diagnostics.expireMcpDiagnosticAuthorizationIfEligible({
    organizationId,
    attemptId,
    generation,
    now: new Date(claimedAt.getTime() + 100),
  })
  expect(expiry.status).toBe("not_eligible")
  expect((await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id }))?.accessToken).toBe("callback-winner-token")
  expect((await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId }))?.attempt.status).toBe("running")
  await diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId,
    phase: "MCP_TOOL_DISCOVERY",
    outcome: "passed",
    healthLevel: "catalog_ready",
    messageSafe: "The callback completed verification.",
    attemptStatus: "succeeded",
  })
})

test("timeout and stale authorization generations reject callback credential writes", async () => {
  const connection = await createOAuthDiagnosticConnection("Timeout wins")
  const client = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: `timeout-wins-client-${crypto.randomUUID()}`,
    createdByOrgMembershipId: adminMemberId,
  })
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const generation = await diagnostics.reserveMcpDiagnosticAuthorizationGeneration({ organizationId, attemptId })
  await markAttemptWaiting({ attemptId })
  expect(await diagnostics.claimMcpDiagnosticAuthorizationCallback({
    organizationId,
    connectionId: connection.id,
    attemptId,
    createdByOrgMembershipId: adminMemberId,
    generation: generation + 1,
  })).toBeNull()

  const claimedAt = new Date()
  const staleLease = await diagnostics.claimMcpDiagnosticAuthorizationCallback({
    organizationId,
    connectionId: connection.id,
    attemptId,
    createdByOrgMembershipId: adminMemberId,
    generation,
    now: claimedAt,
    leaseMs: 10,
  })
  if (!staleLease) throw new Error("Expected callback lease")
  const signedState = `timeout-wins-state-${crypto.randomUUID()}`
  await externalMcpConnections.saveExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    signedState,
    codeVerifier: "timeout-wins-verifier",
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticAttemptId: attemptId,
    diagnosticGeneration: generation,
  })
  const expiry = await diagnostics.expireMcpDiagnosticAuthorizationIfEligible({
    organizationId,
    attemptId,
    generation,
    now: new Date(claimedAt.getTime() + 11),
  })
  expect(expiry.status).toBe("expired")
  await expect(externalMcpConnections.saveExternalMcpCallbackTokens({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticFence: { attemptId, generation, leaseId: staleLease.leaseId },
    pendingGrant: { signedState, diagnosticAttemptId: attemptId, diagnosticGeneration: generation },
    accessToken: "must-not-be-written",
    now: new Date(claimedAt.getTime() + 11),
  })).rejects.toThrow("lease")
  expect((await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id }))?.accessToken).toBeNull()
  expect(await diagnostics.claimMcpDiagnosticAuthorizationCallback({
    organizationId,
    connectionId: connection.id,
    attemptId,
    createdByOrgMembershipId: adminMemberId,
    generation,
  })).toBeNull()
})

test("callback deadline aborts the SDK token exchange without late credential, client, or grant mutation", async () => {
  const connection = await createOAuthDiagnosticConnection("Delayed callback token exchange")
  const client = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: `delayed-callback-client-${crypto.randomUUID()}`,
    clientSecret: "delayed-callback-secret",
    createdByOrgMembershipId: adminMemberId,
  })
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const generation = await diagnostics.reserveMcpDiagnosticAuthorizationGeneration({ organizationId, attemptId })
  await markAttemptWaiting({ attemptId })
  const lease = await diagnostics.claimMcpDiagnosticAuthorizationCallback({
    organizationId,
    connectionId: connection.id,
    attemptId,
    createdByOrgMembershipId: adminMemberId,
    generation,
    leaseMs: 5_000,
  })
  if (!lease) throw new Error("Expected callback lease")

  const signedState = `delayed-callback-state-${crypto.randomUUID()}`
  await externalMcpConnections.saveExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    signedState,
    codeVerifier: "delayed-callback-verifier",
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticAttemptId: attemptId,
    diagnosticGeneration: generation,
  })

  const issuer = "https://login.enterprise.example.test"
  const tokenEndpoint = `${issuer}/oauth2/v2.0/token`
  const io = { active: 0, aborted: 0, completed: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.includes("oauth-protected-resource")) {
      return new Response(JSON.stringify({
        resource: connection.url,
        authorization_servers: [issuer],
        scopes_supported: ["mcp.read"],
      }), { headers: { "content-type": "application/json" } })
    }
    if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) {
      return new Response(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }), { headers: { "content-type": "application/json" } })
    }
    if (url.toString() === tokenEndpoint) {
      io.active += 1
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          io.active -= 1
          io.completed += 1
          resolve(new Response(JSON.stringify({ access_token: "must-never-be-written", token_type: "Bearer" }), {
            headers: { "content-type": "application/json" },
          }))
        }, 1_000)
        const signal = init?.signal
        const abort = () => {
          clearTimeout(timer)
          io.active -= 1
          io.aborted += 1
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      })
    }
    throw new Error(`Unexpected callback fetch path: ${url.pathname}`)
  }) as typeof fetch

  const deadline = externalMcpClient.createExternalMcpLifecycleDeadline(150)
  let failure: unknown
  try {
    await externalMcpClient.completeExternalMcpAuth(
      connection,
      "delayed-authorization-code",
      "https://den.example.test/v1/mcp/callback",
      signedState,
      { attemptId, generation, leaseId: lease.leaseId },
      undefined,
      undefined,
      deadline,
    )
  } catch (error) {
    failure = error
  } finally {
    globalThis.fetch = originalFetch
  }
  await Bun.sleep(25)

  expect(failure).toBeInstanceOf(externalMcpClient.ExternalMcpDiagnosticError)
  expect(failure).toHaveProperty("cause.code", "MCP_LIFECYCLE_DEADLINE")
  expect(deadline.signal.reason).toHaveProperty("code", "MCP_LIFECYCLE_DEADLINE")
  expect(io).toEqual({ active: 0, aborted: 1, completed: 0 })
  const persistenceNow = new Date()
  await expect(externalMcpConnections.saveExternalMcpCallbackTokens({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
    diagnosticFence: { attemptId, generation, leaseId: lease.leaseId },
    pendingGrant: { signedState, diagnosticAttemptId: attemptId, diagnosticGeneration: generation },
    lifecycleDeadlineAt: new Date(persistenceNow.getTime() - 1),
    accessToken: "must-not-pass-expired-persistence-fence",
    now: persistenceNow,
  })).rejects.toHaveProperty("code", "MCP_LIFECYCLE_DEADLINE")
  expect((await externalMcpConnections.getExternalMcpConnection({
    organizationId,
    connectionId: connection.id,
  }))?.accessToken).toBeNull()
  expect(await oauthCredentials.getOrgOAuthClient(organizationId, connection.id)).toMatchObject({
    id: client.id,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    revision: client.revision,
  })
  expect(await externalMcpConnections.getExternalMcpOAuthPendingGrantForCallback({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    signedState,
    diagnosticAttemptId: attemptId,
    diagnosticGeneration: generation,
  })).toMatchObject({
    codeVerifier: "delayed-callback-verifier",
    orgOAuthClientId: client.id,
    clientRevision: client.revision,
  })
  expect((await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId }))?.attempt.status).toBe("waiting_for_authorization")
})

test("authorization URL policy requires public HTTPS when hosted and permits loopback HTTP only in private mode", async () => {
  const original = denEnv.allowPrivateMcpUrls
  try {
    denEnv.allowPrivateMcpUrls = false
    await expect(externalMcpClient.assertSafeMcpAuthorizationUrl("http://1.1.1.1/authorize")).rejects.toThrow("HTTPS")
    await expect(externalMcpClient.assertSafeMcpAuthorizationUrl("https://127.0.0.1/authorize")).rejects.toThrow("private")
    await expect(externalMcpClient.assertSafeMcpAuthorizationUrl("https://user:password@1.1.1.1/authorize")).rejects.toThrow("unsafe")
    await externalMcpClient.assertSafeMcpAuthorizationUrl("https://1.1.1.1/authorize")

    denEnv.allowPrivateMcpUrls = true
    await externalMcpClient.assertSafeMcpAuthorizationUrl("http://127.0.0.1:3978/authorize")
  } finally {
    denEnv.allowPrivateMcpUrls = original
  }
})

test("diagnostic lifecycle accepts an actual server selecting MCP 2025-03-26", async () => {
  if (!fakeServer) throw new Error("Missing MCP fixture server")
  const connection = await createExternalMcpConnection({
    organizationId,
    name: `MCP 2025-03-26 ${crypto.randomUUID()}`,
    url: `http://127.0.0.1:${fakeServer.port}/mcp-2025-03-26`,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const signals: Array<{ phase: string; outcome: string; evidence?: { protocolVersion?: string } }> = []
  const result = await externalMcpClient.diagnoseExternalMcp({
    connection,
    redirectUri: "https://den.example.test/v1/mcp/callback",
    observe: async (signal) => { signals.push(signal) },
  })
  expect(result).toEqual({
    status: "connected",
    protocolVersion: "2025-03-26",
    toolCount: 0,
    pageCount: 1,
  })
  expect(signals.some((signal) => signal.phase === "MCP_VERSION"
    && signal.outcome === "passed"
    && signal.evidence?.protocolVersion === "2025-03-26")).toBe(true)
})

test("diagnostic attempts expire after 24 hours and are removed lazily", async () => {
  const oldNow = new Date(Date.now() - diagnostics.MCP_DIAGNOSTIC_RETENTION_MS - 1_000)
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
    now: oldNow,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  expect(new Date(attempt.expiresAt).getTime() - new Date(attempt.startedAt).getTime()).toBe(diagnostics.MCP_DIAGNOSTIC_RETENTION_MS)
  expect(await diagnostics.cleanupExpiredMcpDiagnostics()).toBeGreaterThanOrEqual(1)
  expect(await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })).toBeNull()
})

test("signed OAuth state binds the callback to the diagnostic attempt", () => {
  const diagnosticAttemptId = createDenTypeId("mcpDiagnosticAttempt")
  const token = genericOAuth.createOAuthStateToken({
    organizationId,
    orgMembershipId: adminMemberId,
    providerId: requireConnectionId(),
    diagnosticAttemptId,
    diagnosticAttemptGeneration: 7,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  expect(genericOAuth.verifyOAuthStateToken({ token, secret: process.env.BETTER_AUTH_SECRET ?? "" })?.diagnosticAttemptId).toBe(diagnosticAttemptId)
  expect(genericOAuth.verifyOAuthStateToken({ token, secret: process.env.BETTER_AUTH_SECRET ?? "" })?.diagnosticAttemptGeneration).toBe(7)
  expect(genericOAuth.verifyOAuthStateToken({ token: `${token}x`, secret: process.env.BETTER_AUTH_SECRET ?? "" })).toBeNull()
})

test("OAuth denial closes a diagnostic with a bounded error and no provider description", async () => {
  const connection = requireConnectionId()
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const generation = await diagnostics.reserveMcpDiagnosticAuthorizationGeneration({ organizationId, attemptId })
  await markAttemptWaiting({ attemptId })
  const state = genericOAuth.createOAuthStateToken({
    organizationId,
    orgMembershipId: adminMemberId,
    providerId: connection,
    diagnosticAttemptId: attemptId,
    diagnosticAttemptGeneration: generation,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callback = await app.fetch(new Request(
    `http://den-api.local/v1/mcp-connections/${connection}/connect/callback?error=access_denied&error_description=provider-secret-description&state=${encodeURIComponent(state)}`,
  ))
  expect(callback.status).toBe(400)
  const html = await callback.text()
  expect(html).toContain("authorization was denied or cancelled")
  expect(html).not.toContain("provider-secret-description")

  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.attempt.status).toBe("failed")
  expect(snapshot?.attempt.firstFailedPhase).toBe("AUTH_USER_OR_WORKLOAD")
  expect(snapshot?.attempt.firstFailureCategory).toBe("oauth_authorization_denied")
  expect(snapshot?.events.at(-1)?.evidence.errorCode).toBe("access_denied")
})

test("diagnostic callback authority is rechecked after OAuth", async () => {
  expect(await diagnostics.getMcpDiagnosticAdminActorUserId({
    organizationId,
    memberId: adminMemberId,
  })).toBe(userId)

  await db.update(schema.MemberTable).set({ role: "member" }).where(drizzle.eq(schema.MemberTable.id, adminMemberId))
  try {
    expect(await diagnostics.getMcpDiagnosticAdminActorUserId({
      organizationId,
      memberId: adminMemberId,
    })).toBeNull()
  } finally {
    await db.update(schema.MemberTable).set({ role: "owner" }).where(drizzle.eq(schema.MemberTable.id, adminMemberId))
  }
})

test("background diagnostic execution completes with no SSE subscriber", async () => {
  const connection = await externalMcpConnections.getExternalMcpConnection({
    organizationId,
    connectionId: requireConnectionId(),
  })
  if (!connection) throw new Error("Missing diagnostic fixture connection")
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const execution = externalMcpDiagnosticRunner.startExternalMcpDiagnosticExecution({
    organizationId,
    attemptId,
    connection,
    orgMembershipId: adminMemberId,
    redirectUri: "https://den.example.test/v1/mcp/callback",
    diagnose: async (input) => {
      await input.observe({
        phase: "HTTP_ROUTING",
        outcome: "passed",
        healthLevel: "reachable",
        messageSafe: "The no-subscriber fixture reached the endpoint.",
      })
      await input.observe({
        phase: "MCP_TOOL_DISCOVERY",
        outcome: "passed",
        healthLevel: "catalog_ready",
        messageSafe: "The no-subscriber fixture returned its catalog.",
        attemptStatus: "succeeded",
      })
      return { status: "connected", protocolVersion: "2025-03-26", toolCount: 1, pageCount: 1 }
    },
  })
  await execution.done
  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.attempt.status).toBe("succeeded")
  expect(snapshot?.events.map((event) => event.sequence)).toEqual([1, 2, 3])
})

test("connection deletion cancels a live runner and removes diagnostic detail transactionally", async () => {
  const connection = await createExternalMcpConnection({
    organizationId,
    name: `Disposable live diagnostic ${crypto.randomUUID()}`,
    url: `http://127.0.0.1:${fakeServer?.port}/mcp`,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  let releaseDiagnosis: (() => void) | undefined
  let markDiagnosisStarted: (() => void) | undefined
  const diagnosisStarted = new Promise<void>((resolve) => { markDiagnosisStarted = resolve })
  const diagnosisBlocked = new Promise<void>((resolve) => { releaseDiagnosis = resolve })
  const execution = externalMcpDiagnosticRunner.startExternalMcpDiagnosticExecution({
    organizationId,
    attemptId,
    connection,
    orgMembershipId: adminMemberId,
    redirectUri: "https://den.example.test/v1/mcp/callback",
    diagnose: async () => {
      markDiagnosisStarted?.()
      await diagnosisBlocked
      return { status: "connected", protocolVersion: "2025-03-26", toolCount: 0, pageCount: 1 }
    },
  })
  await diagnosisStarted

  expect(await externalMcpConnections.deleteExternalMcpConnection({
    organizationId,
    connectionId: connection.id,
  })).toBe(true)
  await Promise.race([
    execution.done,
    Bun.sleep(1_000).then(() => { throw new Error("Deleted diagnostic runner did not cancel") }),
  ])
  expect(externalMcpDiagnosticRunner.getExternalMcpDiagnosticExecution(attemptId)).toBeNull()
  expect(await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })).toBeNull()
  expect(await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id })).toBeNull()
  releaseDiagnosis?.()
})

test("diagnostic start and connection deletion cannot create an orphan attempt", async () => {
  const connection = await createExternalMcpConnection({
    organizationId,
    name: `Diagnostic delete race ${crypto.randomUUID()}`,
    url: `http://127.0.0.1:${fakeServer?.port}/mcp`,
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const [started, removed] = await Promise.allSettled([
    diagnostics.createMcpDiagnosticAttempt({
      organizationId,
      connectionId: connection.id,
      createdByOrgMembershipId: adminMemberId,
    }),
    externalMcpConnections.deleteExternalMcpConnection({
      organizationId,
      connectionId: connection.id,
    }),
  ])

  expect(removed).toEqual({ status: "fulfilled", value: true })
  if (started.status === "rejected") expect(String(started.reason)).toContain("Unknown MCP connection")
  const remainingAttempts = await db
    .select({ id: schema.McpDiagnosticAttemptTable.id })
    .from(schema.McpDiagnosticAttemptTable)
    .where(drizzle.eq(schema.McpDiagnosticAttemptTable.externalMcpConnectionId, connection.id))
  expect(remainingAttempts).toHaveLength(0)
  expect(await externalMcpConnections.getExternalMcpConnection({ organizationId, connectionId: connection.id })).toBeNull()
})

test("authorization timeout runs without subscribers and removes its bound PKCE grant", async () => {
  const connection = await createOAuthDiagnosticConnection("No subscriber OAuth")
  const client = await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: `no-subscriber-client-${crypto.randomUUID()}`,
    createdByOrgMembershipId: adminMemberId,
  })
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: connection.id,
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  let signedState = ""
  const execution = externalMcpDiagnosticRunner.startExternalMcpDiagnosticExecution({
    organizationId,
    attemptId,
    connection,
    orgMembershipId: adminMemberId,
    redirectUri: "https://den.example.test/v1/mcp/callback",
    authWaitMs: 10,
    pollMs: 1,
    diagnose: async (input) => {
      if (!input.signedState || !input.diagnosticAuthorization) throw new Error("Missing diagnostic OAuth binding")
      signedState = input.signedState
      await externalMcpConnections.saveExternalMcpOAuthPendingGrant({
        organizationId,
        connectionId: connection.id,
        orgMembershipId: null,
        signedState,
        codeVerifier: "no-subscriber-verifier",
        orgOAuthClientId: client.id,
        clientRevision: client.revision,
        diagnosticAttemptId: input.diagnosticAuthorization.attemptId,
        diagnosticGeneration: input.diagnosticAuthorization.generation,
      })
      await input.observe({
        phase: "AUTH_USER_OR_WORKLOAD",
        outcome: "waiting",
        healthLevel: "reachable",
        messageSafe: "Waiting for the no-subscriber fixture authorization.",
        actionOwner: "member",
        operatorAction: "complete_provider_authorization",
        attemptStatus: "waiting_for_authorization",
      })
      return { status: "needs_auth", authorizeUrl: "https://issuer.example.test/authorize" }
    },
  })
  await execution.done
  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.attempt.status).toBe("expired")
  expect(snapshot?.attempt.firstFailedPhase).toBe("AUTH_USER_OR_WORKLOAD")
  await expect(externalMcpConnections.consumeExternalMcpOAuthPendingGrant({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: null,
    signedState,
    diagnosticAttemptId: attemptId,
    diagnosticGeneration: execution.generation,
  })).rejects.toThrow("already consumed")
})

test("disconnecting the initial SSE does not abort execution and reconnect replays completion", async () => {
  const connection = requireConnectionId()
  const response = await request(adminToken, `/v1/mcp-connections/${connection}/diagnostics/stream`, "POST")
  expect(response.status).toBe(200)
  const attemptId = response.headers.get("x-openwork-mcp-diagnostic-attempt-id")
  if (!attemptId || !response.body) throw new Error("Diagnostic response did not expose its attempt id or body")
  const normalizedAttemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attemptId)
  const reader = response.body.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  await reader.cancel("test subscriber disconnected")

  const completed = await waitForTerminalAttempt(normalizedAttemptId)
  expect(completed.attempt.status).toBe("succeeded")
  const resumeAfter = completed.events.at(0)?.sequence ?? 0
  const reconnected = await request(
    adminToken,
    `/v1/mcp-connections/${connection}/diagnostics/${attemptId}/stream`,
    "GET",
    { "last-event-id": String(resumeAfter) },
  )
  expect(reconnected.status).toBe(200)
  const reconnectedText = await reconnected.text()
  const finalSequence = completed.events.at(-1)?.sequence ?? 0
  expect(reconnectedText).toContain(`id: ${finalSequence}`)
  expect(reconnectedText).not.toContain("event: diagnostic")
  const messages = parseSseData(reconnectedText)
  const replayed = messages.find((message) => isRecord(message) && message.type === "complete")
  expect(replayed).toBeDefined()
  expect(completed.events.map((event) => event.sequence)).toEqual(
    completed.events.map((_, index) => index + 1),
  )
})

test("diagnostic stream is admin-only, tenant-scoped, complete, and redacted", async () => {
  const connection = requireConnectionId()
  const denied = await request(memberToken, `/v1/mcp-connections/${connection}/diagnostics/stream`, "POST")
  expect(denied.status).toBe(403)

  const response = await request(adminToken, `/v1/mcp-connections/${connection}/diagnostics/stream`, "POST")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const text = await response.text()
  expect(text).not.toContain("must-not-appear")
  const messages = parseSseData(text)
  const liveEvent = messages.find((message) => isRecord(message) && message.type === "event")
  expect(liveEvent).toBeDefined()
  if (!isRecord(liveEvent) || !isRecord(liveEvent.attempt)) {
    throw new Error("Diagnostic stream did not include server-authored live attempt state")
  }
  expect(liveEvent.attempt.id).toStartWith("mda_")
  const complete = messages.find((message) => isRecord(message) && message.type === "complete")
  expect(complete).toBeDefined()
  if (!isRecord(complete) || !isRecord(complete.snapshot) || !isRecord(complete.snapshot.attempt)) {
    throw new Error("Diagnostic stream did not include a complete snapshot")
  }
  expect(complete.snapshot.attempt.highestHealthLevel).toBe("catalog_ready")
  expect(complete.snapshot.attempt.firstFailedPhase).toBeNull()
  const attemptId = complete.snapshot.attempt.id
  if (typeof attemptId !== "string") throw new Error("Diagnostic snapshot did not include an attempt id")

  const snapshotResponse = await request(adminToken, `/v1/mcp-connections/${connection}/diagnostics/${attemptId}`)
  expect(snapshotResponse.status).toBe(200)
  const memberSnapshot = await request(memberToken, `/v1/mcp-connections/${connection}/diagnostics/${attemptId}`)
  expect(memberSnapshot.status).toBe(403)
  const crossTenant = await request(otherToken, `/v1/mcp-connections/${connection}/diagnostics/${attemptId}`)
  expect(crossTenant.status).toBe(404)
})

test("diagnostic starts enforce member concurrency and rate limits with a safe 429", async () => {
  await db.delete(schema.McpDiagnosticEventTable).where(drizzle.eq(schema.McpDiagnosticEventTable.organizationId, organizationId))
  await db.delete(schema.McpDiagnosticAttemptTable).where(drizzle.eq(schema.McpDiagnosticAttemptTable.organizationId, organizationId))
  try {
    const activeAttempts = await Promise.all([0, 1].map(() => diagnostics.createMcpDiagnosticAttempt({
      organizationId,
      connectionId: requireConnectionId(),
      createdByOrgMembershipId: adminMemberId,
    })))
    const limited = await request(adminToken, `/v1/mcp-connections/${requireConnectionId()}/diagnostics/stream`, "POST")
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("5")
    expect(await limited.json()).toMatchObject({
      error: "diagnostic_start_limited",
      kind: "concurrency",
      scope: "member",
    })

    for (const attempt of activeAttempts) {
      await diagnostics.appendMcpDiagnosticEvent({
        organizationId,
        attemptId: normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id),
        phase: "MCP_TOOL_DISCOVERY",
        outcome: "passed",
        healthLevel: "catalog_ready",
        messageSafe: "The bounded diagnostic completed.",
        attemptStatus: "succeeded",
      })
    }
    for (let index = activeAttempts.length; index < diagnostics.MCP_DIAGNOSTIC_MAX_STARTS_PER_MEMBER_WINDOW; index += 1) {
      const attempt = await diagnostics.createMcpDiagnosticAttempt({
        organizationId,
        connectionId: requireConnectionId(),
        createdByOrgMembershipId: adminMemberId,
      })
      await diagnostics.appendMcpDiagnosticEvent({
        organizationId,
        attemptId: normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id),
        phase: "MCP_TOOL_DISCOVERY",
        outcome: "passed",
        healthLevel: "catalog_ready",
        messageSafe: "The bounded diagnostic completed.",
        attemptStatus: "succeeded",
      })
    }
    await expect(diagnostics.createMcpDiagnosticAttempt({
      organizationId,
      connectionId: requireConnectionId(),
      createdByOrgMembershipId: adminMemberId,
    })).rejects.toMatchObject({ name: "McpDiagnosticStartLimitError", kind: "rate", scope: "member" })
  } finally {
    await db.delete(schema.McpDiagnosticEventTable).where(drizzle.eq(schema.McpDiagnosticEventTable.organizationId, organizationId))
    await db.delete(schema.McpDiagnosticAttemptTable).where(drizzle.eq(schema.McpDiagnosticAttemptTable.organizationId, organizationId))
  }
})

test("diagnostic starts enforce an organization-wide concurrency ceiling", async () => {
  const now = new Date()
  const rows = Array.from({ length: diagnostics.MCP_DIAGNOSTIC_MAX_ACTIVE_PER_ORGANIZATION }, () => ({
    id: createDenTypeId("mcpDiagnosticAttempt"),
    organizationId,
    externalMcpConnectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
    completionAuditEventId: createDenTypeId("auditEvent"),
    startedAt: now,
    expiresAt: new Date(now.getTime() + diagnostics.MCP_DIAGNOSTIC_RETENTION_MS),
  }))
  await db.insert(schema.McpDiagnosticAttemptTable).values(rows)
  try {
    await expect(diagnostics.createMcpDiagnosticAttempt({
      organizationId,
      connectionId: requireConnectionId(),
      createdByOrgMembershipId: memberId,
    })).rejects.toMatchObject({ name: "McpDiagnosticStartLimitError", kind: "concurrency", scope: "organization" })
  } finally {
    await db.delete(schema.McpDiagnosticAttemptTable).where(drizzle.eq(schema.McpDiagnosticAttemptTable.organizationId, organizationId))
  }
})

test("completion audit emission is idempotent across runner and callback retries", async () => {
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  await diagnostics.appendMcpDiagnosticEvent({
    organizationId,
    attemptId,
    phase: "MCP_TOOL_DISCOVERY",
    outcome: "passed",
    healthLevel: "catalog_ready",
    messageSafe: "The audit fixture completed.",
    attemptStatus: "succeeded",
  })
  const recordCompletion = () => diagnostics.recordMcpDiagnosticCompletionAuditOnce({
    organizationId,
    actorUserId: userId,
    attemptId,
    connectionId: requireConnectionId(),
    status: "succeeded",
    highestHealthLevel: "catalog_ready",
    firstFailedPhase: null,
  })
  await Promise.all([
    recordCompletion(),
    recordCompletion(),
  ])
  const attempts = await db
    .select({ auditEventId: schema.McpDiagnosticAttemptTable.completionAuditEventId })
    .from(schema.McpDiagnosticAttemptTable)
    .where(drizzle.eq(schema.McpDiagnosticAttemptTable.id, attemptId))
    .limit(1)
  const auditEventId = attempts[0]?.auditEventId
  if (!auditEventId) throw new Error("Diagnostic attempt did not allocate a completion audit id")
  const auditRows = await db
    .select()
    .from(schema.AuditEventTable)
    .where(drizzle.eq(schema.AuditEventTable.id, auditEventId))
  expect(auditRows).toHaveLength(1)
})

test("an expired process lease becomes a clear retryable terminal result", async () => {
  const now = new Date()
  const attempt = await diagnostics.createMcpDiagnosticAttempt({
    organizationId,
    connectionId: requireConnectionId(),
    createdByOrgMembershipId: adminMemberId,
    now,
  })
  const attemptId = normalizeDenTypeId("mcpDiagnosticAttempt", attempt.id)
  const lease = await diagnostics.claimMcpDiagnosticExecutionLease({
    organizationId,
    attemptId,
    now,
    leaseMs: 100,
  })
  expect(lease).not.toBeNull()
  expect(await diagnostics.recoverAbandonedMcpDiagnosticAttempt({
    organizationId,
    attemptId,
    now: new Date(now.getTime() + 99),
  })).toBeNull()
  const recovered = await diagnostics.recoverAbandonedMcpDiagnosticAttempt({
    organizationId,
    attemptId,
    now: new Date(now.getTime() + 101),
  })
  expect(recovered?.phase).toBe("CONTINUITY_SESSION")
  expect(recovered?.category).toBe("diagnostic_execution_interrupted")
  expect(recovered?.retryable).toBe(true)
  expect(recovered?.evidence).toEqual({ errorCode: "MCP_DIAGNOSTIC_EXECUTION_LOST", detailsRedacted: true })
  const snapshot = await diagnostics.getMcpDiagnosticSnapshot({ organizationId, attemptId })
  expect(snapshot?.attempt.status).toBe("failed")
  expect(snapshot?.attempt.actionOwner).toBe("openwork")
  const attemptRows = await db
    .select({ auditEventId: schema.McpDiagnosticAttemptTable.completionAuditEventId })
    .from(schema.McpDiagnosticAttemptTable)
    .where(drizzle.eq(schema.McpDiagnosticAttemptTable.id, attemptId))
    .limit(1)
  const auditEventId = attemptRows[0]?.auditEventId
  if (!auditEventId) throw new Error("Recovered diagnostic did not retain its completion audit id")
  const auditRows = await db
    .select({ id: schema.AuditEventTable.id })
    .from(schema.AuditEventTable)
    .where(drizzle.eq(schema.AuditEventTable.id, auditEventId))
  expect(auditRows).toHaveLength(1)
})
