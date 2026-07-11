import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

const FAULT_CURSOR = "fault-cursor-secret"
const FAULT_SESSION_ID = "fault-session-secret"
const FAULT_ACCESS_TOKEN = "mock-access-token"
const FAULT_PATH_SEGMENT = "fault-path-secret"
const FAULT_URL_QUERY = "fault-url-query-secret"
const FAULT_ENDPOINT = `/tenants/${FAULT_PATH_SEGMENT}/mcp`
const DIAGNOSTICS_KEY = "den-api-connection-test-key"
const DEN_SDK_REDIRECT_URI = "http://127.0.0.1:8790/v1/mcp-connections/mock/connect/callback"
const PREREGISTERED_CLIENT_ID = "mock-preregistered-client"
const PREREGISTERED_CLIENT_SECRET = "mock-preregistered-secret"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_mcp_connection_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("failed to allocate a mock port")
  return port
}

async function startMock(profile: string, fault = "none", extraEnv: Record<string, string> = {}) {
  const port = await getFreePort()
  const script = resolve(import.meta.dir, "../../../../scripts/mock-oauth-mcp-server.mjs")
  const child = spawn(process.execPath, [script, "--port", String(port), "--profile", profile, "--fault", fault], {
    env: {
      ...process.env,
      AUTO_APPROVE: "1",
      MCP_MOCK_DIAGNOSTICS_KEY: DIAGNOSTICS_KEY,
      ...(fault === "cursor_loop" ? {
        MCP_MOCK_CURSOR_VALUE: FAULT_CURSOR,
        MCP_MOCK_ENDPOINT: FAULT_ENDPOINT,
        MCP_MOCK_SESSION_ID: FAULT_SESSION_ID,
      } : {}),
      ...extraEnv,
    },
    stdio: "ignore",
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return { child, baseUrl }
    } catch {
      // The child may still be starting.
    }
    await Bun.sleep(25)
  }
  child.kill()
  throw new Error(`timed out starting ${profile} mock`)
}

function stopMock(child: ChildProcess | undefined) {
  if (child && child.exitCode === null) child.kill()
}

async function diagnosticCounts(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/__diagnostics/state`, {
    headers: { "x-mock-diagnostics-key": DIAGNOSTICS_KEY },
  })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || !isRecord(body.counts)) throw new Error("mock diagnostic state omitted counts")
  return body.counts
}

async function runNodeConnectionTest(connection: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const root = resolve(import.meta.dir, "../../../..")
  const source = `void (async () => {
    const { testExternalMcpConnection } = await import("./src/capability-sources/external-mcp-client.ts");
    const connection = JSON.parse(process.env.MCP_TEST_CONNECTION || "null");
    const timeoutMs = Number(process.env.MCP_TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const result = await testExternalMcpConnection(connection, "http://127.0.0.1:8790/v1/mcp-connections/mock/connect/callback", undefined, { timeoutMs });
      console.log(JSON.stringify({ ok: true, result, elapsedMs: Date.now() - startedAt }));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      console.log(JSON.stringify({ ok: false, code, elapsedMs: Date.now() - startedAt }));
    }
  })();`
  const child = spawn("pnpm", ["--dir", "ee/apps/den-api", "exec", "tsx", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      DEN_ALLOW_PRIVATE_MCP_URLS: "1",
      MCP_TEST_CONNECTION: JSON.stringify(connection),
      MCP_TEST_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => { stdout += String(chunk) })
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const exitCode = await Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
    Bun.sleep(5_000).then(() => "timeout"),
  ])
  if (exitCode === "timeout") {
    child.kill()
    throw new Error("Node MCP connection-test probe timed out")
  }
  if (exitCode !== 0) throw new Error(`Node MCP connection-test probe failed: ${stderr.slice(0, 500)}`)
  const line = stdout.trim().split("\n").at(-1)
  if (!line) throw new Error("Node MCP connection-test probe returned no result")
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed)) throw new Error("Node MCP connection-test probe result was invalid")
  return parsed
}

seedRequiredEnv()

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let mcpClient: typeof import("../src/capability-sources/external-mcp-client.js")
let connectionId: DenTypeId<"externalMcpConnection"> | undefined
let disconnectedConnectionId: DenTypeId<"externalMcpConnection"> | undefined
let loopingConnectionId: DenTypeId<"externalMcpConnection"> | undefined
let serviceNowMock: ChildProcess | undefined
let loopMock: ChildProcess | undefined
let serviceNowBaseUrl: string | undefined

const userId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const adminMemberId = createDenTypeId("member")
const regularMemberId = createDenTypeId("member")
const otherUserId = createDenTypeId("user")
const otherOrganizationId = createDenTypeId("organization")
const otherMemberId = createDenTypeId("member")

beforeAll(async () => {
  const [serviceNow, looping] = await Promise.all([
    startMock("servicenow"),
    startMock("workiq", "cursor_loop"),
  ])
  serviceNowMock = serviceNow.child
  serviceNowBaseUrl = serviceNow.baseUrl
  loopMock = looping.child

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, connectionsMod, oauthCredentialsMod, mcpClientMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/capability-sources/external-mcp-client.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  connections = connectionsMod
  oauthCredentials = oauthCredentialsMod
  mcpClient = mcpClientMod

  await db.insert(schema.AuthUserTable).values([
    { id: userId, name: "MCP Test Admin", email: `mcp-test-admin+${userId}@test.local` },
    { id: memberUserId, name: "MCP Test Member", email: `mcp-test-member+${memberUserId}@test.local` },
    { id: otherUserId, name: "Other Org Admin", email: `mcp-test-other+${otherUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values([
    {
      id: organizationId,
      name: "MCP Connection Test Org",
      slug: `mcp-connection-test-${organizationId}`,
    },
    {
      id: otherOrganizationId,
      name: "Other MCP Test Org",
      slug: `mcp-connection-test-${otherOrganizationId}`,
    },
  ])
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId, role: "admin" },
    { id: regularMemberId, organizationId, userId: memberUserId, role: "member" },
    { id: otherMemberId, organizationId: otherOrganizationId, userId: otherUserId, role: "admin" },
  ])

  const connected = await connectionsMod.createExternalMcpConnection({
    organizationId,
    name: "Synthetic ServiceNow",
    url: `${serviceNow.baseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  connectionId = connected.id
  await connectionsMod.saveExternalMcpTokens({
    connectionId: connected.id,
    accessToken: FAULT_ACCESS_TOKEN,
    tokenType: "Bearer",
    scope: "mcp_server",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  const disconnected = await connectionsMod.createExternalMcpConnection({
    organizationId,
    name: "Disconnected MCP",
    url: `${serviceNow.baseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  disconnectedConnectionId = disconnected.id

  const loopConnection = await connectionsMod.createExternalMcpConnection({
    organizationId,
    name: "Looping Work IQ",
    url: `${looping.baseUrl}${FAULT_ENDPOINT}?diagnostic_token=${FAULT_URL_QUERY}`,
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  loopingConnectionId = loopConnection.id
  await connectionsMod.saveExternalMcpTokens({
    connectionId: loopConnection.id,
    accessToken: FAULT_ACCESS_TOKEN,
    tokenType: "Bearer",
    scope: "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
})

afterAll(async () => {
  if (db && schema && drizzle) {
    await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
    await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
    await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
    await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, otherOrganizationId))
    await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
    await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, otherOrganizationId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, otherOrganizationId))
    await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, memberUserId, otherUserId]))
  }
  stopMock(serviceNowMock)
  stopMock(loopMock)
})

function seededId(value: DenTypeId<"externalMcpConnection"> | undefined): DenTypeId<"externalMcpConnection"> {
  if (!value) throw new Error("connection fixture was not seeded")
  return value
}

async function seedSharedOauthConnection(
  name: string,
  url: string,
  scope: string,
  accessToken = FAULT_ACCESS_TOKEN,
) {
  const connection = await connections.createExternalMcpConnection({
    organizationId,
    name,
    url,
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await connections.saveExternalMcpTokens({
    connectionId: connection.id,
    accessToken,
    tokenType: "Bearer",
    scope,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return connection.id
}

function request(
  connection: DenTypeId<"externalMcpConnection">,
  callerUserId = userId,
  callerOrganizationId = organizationId,
) {
  return app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${connection}/test`, {
    method: "POST",
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId: callerUserId, organizationId: callerOrganizationId }),
    },
  }))
}

test("POST connection test initializes, exhausts pages, and returns only redacted readiness", async () => {
  const response = await request(seededId(connectionId))
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("connection test response was not an object")
  expect(body.status).toBe("ready")
  expect(body.warnings).toEqual([])
  expect(body.protocolVersion).toBe("2025-06-18")
  expect(body.transport).toBe("streamable_http")
  expect(body.sessionUsed).toBe(true)
  expect(body.toolPageCount).toBe(2)
  expect(body.toolCount).toBe(4)
  expect(body.toolNames).toEqual(["case_summarization", "incident_summarization", "look_up_case_records", "look_up_incident_records"])
  expect(typeof body.catalogHash === "string" && body.catalogHash.startsWith("sha256:")).toBe(true)
  expect(typeof body.testId === "string" && body.testId.startsWith("mcp-test-")).toBe(true)
  expect(JSON.stringify(body)).not.toContain("mock-access-token")
  expect(JSON.stringify(body)).not.toContain("mcp-session-id")
  if (!serviceNowBaseUrl) throw new Error("ServiceNow mock URL was not seeded")
  const requestLog = await (await fetch(`${serviceNowBaseUrl}/requests`, {
    headers: { "x-mock-diagnostics-key": DIAGNOSTICS_KEY },
  })).json()
  const deletes = requestLog.requests.filter((entry: { method?: string }) => entry.method === "DELETE")
  expect(deletes).toHaveLength(1)
})

test("shared connections require admin authority and an existing credential", async () => {
  const forbidden = await request(seededId(connectionId), memberUserId)
  expect(forbidden.status).toBe(403)

  const disconnected = await request(seededId(disconnectedConnectionId))
  expect(disconnected.status).toBe(409)
  const body: unknown = await disconnected.json()
  expect(isRecord(body) && body.error).toBe("connection_not_connected")
})

test("OAuth connection tests are byte-stable reads and never start authorization or registration", async () => {
  if (!serviceNowBaseUrl) throw new Error("ServiceNow mock URL was not seeded")
  const staleAccessToken = "stale-access-token-must-survive-test"
  const staleRefreshToken = "stale-refresh-token-must-survive-test"
  const pendingCodeVerifier = "pending-pkce-verifier-must-survive-test"
  const stale = await connections.createExternalMcpConnection({
    organizationId,
    name: "Stale read-only OAuth probe",
    url: `${serviceNowBaseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await connections.saveExternalMcpTokens({
    connectionId: stale.id,
    accessToken: staleAccessToken,
    refreshToken: staleRefreshToken,
    tokenType: "Bearer",
    scope: "mcp_server",
    expiresAt: new Date(Date.now() - 60_000),
  })
  await connections.saveExternalMcpPendingCodeVerifier({
    connectionId: stale.id,
    codeVerifier: pendingCodeVerifier,
  })
  await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId: stale.id,
    clientId: "manual-servicenow-client",
    clientSecret: "manual-servicenow-secret",
    extra: {
      clientInformation: {
        client_id: "manual-servicenow-client",
        client_secret: "manual-servicenow-secret",
        token_endpoint_auth_method: "client_secret_post",
      },
    },
    createdByOrgMembershipId: adminMemberId,
  })

  const snapshot = async () => {
    const [connection, client] = await Promise.all([
      connections.getExternalMcpConnection({ organizationId, connectionId: stale.id }),
      oauthCredentials.getOrgOAuthClient(organizationId, stale.id),
    ])
    if (!connection || !client) throw new Error("read-only OAuth fixture was not persisted")
    return JSON.stringify({
      credential: {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        tokenType: connection.tokenType,
        scope: connection.scope,
        expiresAt: connection.expiresAt?.toISOString(),
        pendingCodeVerifier: connection.pendingCodeVerifier,
        connectedAt: connection.connectedAt?.toISOString(),
        updatedAt: connection.updatedAt?.toISOString(),
      },
      client: {
        id: client.id,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        extra: client.extra,
        updatedAt: client.updatedAt?.toISOString(),
      },
    })
  }

  const logBefore = await (await fetch(`${serviceNowBaseUrl}/requests`, {
    headers: { "x-mock-diagnostics-key": DIAGNOSTICS_KEY },
  })).json()
  const before = await snapshot()
  const response = await request(stale.id)
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  expect(isRecord(body) && body.code).toBe("mcp_reauth_required")
  expect(await snapshot()).toBe(before)

  const logAfter = await (await fetch(`${serviceNowBaseUrl}/requests`, {
    headers: { "x-mock-diagnostics-key": DIAGNOSTICS_KEY },
  })).json()
  const newRequests = logAfter.requests.slice(logBefore.requests.length) as Array<{ path?: string }>
  expect(newRequests.some((entry) => ["/register", "/authorize", "/token", "/approve"].includes(entry.path ?? ""))).toBe(false)
  expect(JSON.stringify(logAfter)).not.toContain(staleAccessToken)
  expect(JSON.stringify(logAfter)).not.toContain(staleRefreshToken)
  expect(JSON.stringify(logAfter)).not.toContain(pendingCodeVerifier)
})

test("HTTP 401 requires reauthorization while HTTP 403 identifies provider permissions and ACLs", async () => {
  const cases = [
    {
      fault: "none",
      accessToken: "mock-wrong-audience-token",
      code: "mcp_reauth_required",
      message: "The existing MCP credential was rejected. Reconnect this account, then test again.",
    },
    {
      fault: "insufficient_scope",
      accessToken: FAULT_ACCESS_TOKEN,
      code: "mcp_provider_permission_denied",
      message: "The MCP provider denied access to this connection. Ask a provider administrator to review account assignments, roles, ACLs, and required scopes, then test again.",
    },
  ] as const

  for (const expected of cases) {
    const mock = await startMock("workiq", expected.fault)
    try {
      const connection = await seedSharedOauthConnection(
        `HTTP ${expected.fault}`,
        `${mock.baseUrl}/mcp`,
        "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
        expected.accessToken,
      )
      const response = await request(connection)
      expect(response.status).toBe(502)
      const body: unknown = await response.json()
      expect(isRecord(body) && body.error).toBe("connection_test_failed")
      expect(isRecord(body) && body.code).toBe(expected.code)
      expect(isRecord(body) && body.message).toBe(expected.message)
      expect(isRecord(body) && typeof body.testId === "string" && body.testId.startsWith("mcp-test-")).toBe(true)
      expect(JSON.stringify(body)).not.toContain(expected.accessToken)
    } finally {
      stopMock(mock.child)
    }
  }
})

test("default enterprise confidential-client OAuth completes through the production Den MCP SDK in JSON and SSE modes", async () => {
  const scenarios = [
    {
      profile: "servicenow",
      endpoint: "/sncapps/mcp-server/mcp/sn_mcp_server_default",
      scope: "mcp_server",
      authorizationPath: "/oauth_auth.do",
      tokenPath: "/oauth_token.do",
      toolCount: 4,
    },
    {
      profile: "workiq",
      endpoint: "/mcp",
      scope: "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
      authorizationPath: "/mock-entra/mock-tenant/oauth2/v2.0/authorize",
      tokenPath: "/mock-entra/mock-tenant/oauth2/v2.0/token",
      toolCount: 10,
    },
    {
      profile: "microsoft-enterprise",
      endpoint: "/enterprise",
      scope: "MCP.User.Read.All",
      authorizationPath: "/mock-entra/mock-tenant/oauth2/v2.0/authorize",
      tokenPath: "/mock-entra/mock-tenant/oauth2/v2.0/token",
      toolCount: 3,
    },
    {
      profile: "agent365-mail",
      endpoint: "/agents/tenants/mock-tenant/servers/mcp_MailTools",
      scope: "McpServers.Mail.All",
      authorizationPath: "/mock-entra/mock-tenant/oauth2/v2.0/authorize",
      tokenPath: "/mock-entra/mock-tenant/oauth2/v2.0/token",
      toolCount: 10,
    },
  ] as const

  for (const responseMode of ["json", "sse"] as const) {
    for (const scenario of scenarios) {
      const mock = await startMock(scenario.profile, "none", {
        MCP_MOCK_RESPONSE_MODE: responseMode,
        MOCK_REDIRECT_URIS: DEN_SDK_REDIRECT_URI,
      })
      try {
        const connection = await connections.createExternalMcpConnection({
          organizationId,
          name: `Real SDK ${scenario.profile} ${responseMode}`,
          url: `${mock.baseUrl}${scenario.endpoint}`,
          authType: "oauth",
          credentialMode: "shared",
          createdByOrgMembershipId: adminMemberId,
          access: { orgWide: true, memberIds: [], teamIds: [] },
        })
        // Deliberately persist the legacy/manual shape without an auth-method
        // hint. This reproduces real Den configuration and forces the SDK to
        // choose from the provider discovery document.
        await oauthCredentials.upsertOrgOAuthClient({
          organizationId,
          providerId: connection.id,
          clientId: PREREGISTERED_CLIENT_ID,
          clientSecret: PREREGISTERED_CLIENT_SECRET,
          extra: {},
          createdByOrgMembershipId: adminMemberId,
        })

        const signedState = `signed-state-${connection.id}-${scenario.profile}-${responseMode}`
        const started = await mcpClient.connectExternalMcp(
          connection,
          DEN_SDK_REDIRECT_URI,
          signedState,
        )
        expect(started.status).toBe("needs_auth")
        if (started.status !== "needs_auth") throw new Error(`${scenario.profile} did not request authorization`)
        const authorizeUrl = new URL(started.authorizeUrl)
        expect(authorizeUrl.pathname).toBe(scenario.authorizationPath)
        expect(authorizeUrl.searchParams.get("resource")).toBe(`${mock.baseUrl}${scenario.endpoint}`)

        const authorization = await fetch(authorizeUrl, { redirect: "manual" })
        expect(authorization.status).toBe(302)
        const location = authorization.headers.get("location")
        if (!location) throw new Error(`${scenario.profile} authorization omitted callback`)
        const callback = new URL(location)
        const code = callback.searchParams.get("code")
        if (!code) throw new Error(`${scenario.profile} authorization omitted code`)
        expect(callback.searchParams.get("state")).toBe(signedState)

        const pending = await connections.getExternalMcpConnection({ organizationId, connectionId: connection.id })
        if (!pending) throw new Error(`${scenario.profile} connection disappeared before its OAuth callback`)
        const pendingGrant = await connections.getExternalMcpOAuthPendingGrantForCallback({
          organizationId,
          connectionId: connection.id,
          orgMembershipId: null,
          signedState,
        })
        expect(pendingGrant.codeVerifier.length).toBeGreaterThan(0)
        await mcpClient.completeExternalMcpAuth({
          connection: pending,
          code,
          redirectUri: DEN_SDK_REDIRECT_URI,
          signedState,
        })

        const connected = await connections.getExternalMcpConnection({ organizationId, connectionId: connection.id })
        if (!connected?.accessToken || !connected.refreshToken) throw new Error(`${scenario.profile} did not persist OAuth tokens`)
        const readiness = await mcpClient.testExternalMcpConnection(
          connected,
          DEN_SDK_REDIRECT_URI,
          undefined,
          { timeoutMs: 3_000 },
        )
        expect(readiness).toMatchObject({
          status: "ready",
          warnings: [],
          toolCount: scenario.toolCount,
        })

        const requestLog = await (await fetch(`${mock.baseUrl}/requests`, {
          headers: { "x-mock-diagnostics-key": DIAGNOSTICS_KEY },
        })).json() as { requests: Array<{ path: string; url: string }> }
        const paths = requestLog.requests.map((entry) => entry.path)
        expect(paths).toContain(scenario.authorizationPath)
        expect(paths).toContain(scenario.tokenPath)
        expect(paths).not.toContain("/register")
        expect(paths).not.toContain("/token")
        expect(JSON.stringify(requestLog)).not.toContain(code)
        expect(JSON.stringify(requestLog)).not.toContain(connected.accessToken)
        expect(JSON.stringify(requestLog)).not.toContain(connected.refreshToken)
        expect((await diagnosticCounts(mock.baseUrl)).activeRequests).toBe(0)
      } finally {
        stopMock(mock.child)
      }
    }
  }
}, 60_000)

test("test authority and credentials remain tenant-, member-, API-key-, and no-auth-scoped", async () => {
  expect((await request(seededId(connectionId), otherUserId, otherOrganizationId)).status).toBe(404)
  if (!serviceNowBaseUrl) throw new Error("ServiceNow mock URL was not seeded")

  const perMember = await connections.createExternalMcpConnection({
    organizationId,
    name: "Per-member ServiceNow",
    url: `${serviceNowBaseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: regularMemberId,
    providerId: perMember.id,
    accessToken: FAULT_ACCESS_TOKEN,
    tokenType: "Bearer",
    scopes: ["mcp_server"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  expect((await request(perMember.id, memberUserId)).status).toBe(200)
  expect((await request(perMember.id, userId)).status).toBe(409)

  const apiKey = await connections.createExternalMcpConnection({
    organizationId,
    name: "API-key ServiceNow",
    url: `${serviceNowBaseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
    authType: "apikey",
    credentialMode: "shared",
    apiKey: FAULT_ACCESS_TOKEN,
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  expect((await request(apiKey.id)).status).toBe(200)

  const noAuthMock = await startMock("servicenow", "none", { MCP_MOCK_AUTH_MODE: "none" })
  try {
    const noAuth = await connections.createExternalMcpConnection({
      organizationId,
      name: "No-auth diagnostic MCP",
      url: `${noAuthMock.baseUrl}/sncapps/mcp-server/mcp/sn_mcp_server_default`,
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: adminMemberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    expect((await request(noAuth.id)).status).toBe(200)
  } finally {
    stopMock(noAuthMock.child)
  }
})

test("bounded catalog traversal rejects a repeated cursor", async () => {
  const logged: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => logged.push(args)
  const response = await (async () => {
    try {
      return await request(seededId(loopingConnectionId))
    } finally {
      console.error = originalConsoleError
    }
  })()
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  expect(isRecord(body) && body.error).toBe("connection_test_failed")
  expect(isRecord(body) && body.code).toBe("mcp_catalog_cursor_cycle")
  expect(isRecord(body) && body.message).toBe("The MCP server repeated a tool-catalog pagination cursor.")
  expect(isRecord(body) && typeof body.testId === "string" && body.testId.startsWith("mcp-test-")).toBe(true)
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(FAULT_CURSOR)
  expect(serialized).not.toContain(FAULT_ACCESS_TOKEN)
  expect(serialized).not.toContain(FAULT_SESSION_ID)
  expect(serialized).not.toContain(FAULT_PATH_SEGMENT)
  expect(serialized).not.toContain(FAULT_URL_QUERY)
  expect(serialized).not.toContain("mcp-session-id")
  const serializedLog = JSON.stringify(logged)
  expect(serializedLog).toContain(String(body.testId))
  expect(serializedLog).toContain("mcp_catalog_cursor_cycle")
  const expectedPathHash = createHash("sha256").update(FAULT_ENDPOINT).digest("hex").slice(0, 16)
  expect(serializedLog).toContain(`sha256:${expectedPathHash}`)
  expect(serializedLog).not.toContain(FAULT_CURSOR)
  expect(serializedLog).not.toContain(FAULT_ACCESS_TOKEN)
  expect(serializedLog).not.toContain(FAULT_SESSION_ID)
  expect(serializedLog).not.toContain(FAULT_PATH_SEGMENT)
  expect(serializedLog).not.toContain(FAULT_URL_QUERY)
})

test("catalog diagnostics fail closed on oversized bodies, pages, items, cursors, and names", async () => {
  const cases = [
    ["oversized_catalog_response", "mcp_response_limit_exceeded"],
    ["deep_tool_schema", "mcp_catalog_item_limit_exceeded"],
    ["oversized_schema_string", "mcp_catalog_item_limit_exceeded"],
    ["oversized_cursor", "mcp_catalog_cursor_limit_exceeded"],
    ["oversized_tool_name", "mcp_catalog_tool_name_invalid"],
    ["too_many_page_tools", "mcp_catalog_page_limit_exceeded"],
    ["too_many_total_tools", "mcp_catalog_limit_exceeded"],
    ["too_many_pages", "mcp_catalog_limit_exceeded"],
    ["total_response_budget", "mcp_response_limit_exceeded"],
  ] as const

  for (const [fault, expectedCode] of cases) {
    const mock = await startMock("workiq", fault)
    try {
      const connection = await seedSharedOauthConnection(
        `Bounded ${fault}`,
        `${mock.baseUrl}/mcp`,
        "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
      )
      const response = await request(connection)
      expect(response.status).toBe(502)
      const body: unknown = await response.json()
      expect(isRecord(body) && body.code).toBe(expectedCode)
      expect(isRecord(body) && typeof body.testId === "string" && body.testId.startsWith("mcp-test-")).toBe(true)
      const serialized = JSON.stringify(body)
      expect(serialized.length).toBeLessThan(1_024)
      expect(serialized).not.toContain("x".repeat(128))
      expect(serialized).not.toContain("c".repeat(128))
      expect(serialized).not.toContain("n".repeat(128))
      expect(serialized).not.toContain("s".repeat(128))
    } finally {
      stopMock(mock.child)
    }
  }
})

test("advertised MCP lifecycle faults have stable JSON and SSE diagnostic outcomes with complete cleanup", async () => {
  const cases = [
    ["unsupported_version", "mcp_initialize_failed"],
    ["malformed_initialize", "mcp_initialize_failed"],
    ["notification_rejected", "mcp_initialize_failed"],
    ["wrong_content_type", "mcp_initialize_failed"],
    ["broken_sse", "mcp_test_timeout"],
    ["expired_session", "mcp_catalog_unavailable"],
    ["empty_tool_catalog", "warning"],
  ] as const

  for (const [fault, expected] of cases) {
    for (const responseMode of ["json", "sse"] as const) {
      const mock = await startMock("workiq", fault, { MCP_MOCK_RESPONSE_MODE: responseMode })
      try {
        const connectionId = await seedSharedOauthConnection(
          `${fault} ${responseMode}`,
          `${mock.baseUrl}/mcp`,
          "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
        )
        const connection = await connections.getExternalMcpConnection({ organizationId, connectionId })
        if (!connection) throw new Error(`${fault} ${responseMode} fixture was not seeded`)
        const probe = await runNodeConnectionTest(connection, 750)
        const expectedForMode = fault === "broken_sse" && responseMode === "json" ? "ready_nonempty" : expected
        if (expectedForMode === "warning" || expectedForMode === "ready_nonempty") {
          expect(probe.ok).toBe(true)
          expect(isRecord(probe.result) && probe.result.status).toBe(expectedForMode === "warning" ? "warning" : "ready")
          expect(isRecord(probe.result) && probe.result.toolCount).toBe(expectedForMode === "warning" ? 0 : 10)
          expect(isRecord(probe.result) && probe.result.warnings).toEqual(expectedForMode === "warning" ? ["empty_tool_catalog"] : [])
          if (expectedForMode === "warning") expect(isRecord(probe.result) && probe.result.toolPageCount).toBe(1)
        } else {
          if (probe.ok !== false) throw new Error(`${fault}/${responseMode} unexpectedly returned ${JSON.stringify(probe)}`)
          if (probe.code !== expectedForMode) throw new Error(`${fault}/${responseMode} returned ${String(probe.code)} instead of ${expectedForMode}`)
        }
        expect(JSON.stringify(probe)).not.toContain(FAULT_ACCESS_TOKEN)
        expect((await diagnosticCounts(mock.baseUrl)).activeRequests).toBe(0)
      } finally {
        stopMock(mock.child)
      }
    }
  }
}, 30_000)

test("connection-test timeout aborts the slow response with no active request left", async () => {
  const mock = await startMock("workiq", "slow_tools_list")
  try {
    const connectionId = await seedSharedOauthConnection(
      "Slow Work IQ",
      `${mock.baseUrl}/mcp`,
      "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
    )
    const connection = await connections.getExternalMcpConnection({ organizationId, connectionId })
    if (!connection) throw new Error("slow connection was not seeded")
    const probe = await runNodeConnectionTest(connection, 250)
    expect(probe.ok).toBe(false)
    expect(probe.code).toBe("mcp_test_timeout")
    expect(typeof probe.elapsedMs === "number" && probe.elapsedMs < 500).toBe(true)
    expect((await diagnosticCounts(mock.baseUrl)).activeRequests).toBe(0)
  } finally {
    stopMock(mock.child)
  }
})

test("streaming SSE results are forwarded before EOF and canceled on close", async () => {
  const mock = await startMock("workiq", "open_sse_after_result")
  try {
    const connectionId = await seedSharedOauthConnection(
      "Open SSE Work IQ",
      `${mock.baseUrl}/mcp`,
      "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
    )
    const connection = await connections.getExternalMcpConnection({ organizationId, connectionId })
    if (!connection) throw new Error("open SSE connection was not seeded")
    const probe = await runNodeConnectionTest(connection, 1_000)
    expect(probe.ok).toBe(true)
    expect(isRecord(probe.result) && probe.result.status).toBe("ready")
    expect(isRecord(probe.result) && probe.result.toolCount).toBe(10)
    expect(typeof probe.elapsedMs === "number" && probe.elapsedMs < 1_000).toBe(true)
    expect((await diagnosticCounts(mock.baseUrl)).activeRequests).toBe(0)
  } finally {
    stopMock(mock.child)
  }
})

test("a hung DELETE cannot exceed the lifecycle deadline or outlive settlement", async () => {
  const mock = await startMock("workiq", "hung_delete")
  try {
    const connectionId = await seedSharedOauthConnection(
      "Hung teardown Work IQ",
      `${mock.baseUrl}/mcp`,
      "api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask",
    )
    const connection = await connections.getExternalMcpConnection({ organizationId, connectionId })
    if (!connection) throw new Error("hung teardown connection was not seeded")
    const probe = await runNodeConnectionTest(connection, 250)
    expect(probe.ok).toBe(true)
    expect(isRecord(probe.result) && probe.result.status).toBe("ready")
    expect(typeof probe.elapsedMs === "number" && probe.elapsedMs < 500).toBe(true)
    expect((await diagnosticCounts(mock.baseUrl)).activeRequests).toBe(0)
  } finally {
    stopMock(mock.child)
  }
})
