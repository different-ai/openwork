import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"
const REDIRECT_URI = "http://127.0.0.1:49152/oauth/callback"
const AGENT_RESOURCE = `${API_ORIGIN}/mcp/agent`
const TEST_ACCESS_TOKEN_TTL_SECONDS = 2
const ACCESS_TOKEN_EXPIRY_WAIT_MS = TEST_ACCESS_TOKEN_TTL_SECONDS * 1000 + 350
const MCP_SCOPE = "mcp:read mcp:write offline_access"
const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const RUN_REFRESH_LIFECYCLE_CHILD = process.env.DEN_MCP_REFRESH_LIFECYCLE_CHILD === "1"

if (!RUN_REFRESH_LIFECYCLE_CHILD) {
  test("MCP OAuth refresh lifecycle integration", () => {
    const result = spawnSync(
      process.execPath,
      ["test", "--conditions", "development", "--timeout", "15000", "test/mcp-oauth-refresh-lifecycle.test.ts"],
      {
        cwd: denApiRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DEN_MCP_REFRESH_LIFECYCLE_CHILD: "1",
        },
        timeout: 60_000,
      },
    )

    if (result.status !== 0) {
      throw new Error([
        "MCP OAuth refresh lifecycle child test failed",
        `status: ${result.status}`,
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
      ].join("\n"))
    }
    expect(result.status).toBe(0)
  }, 70_000)
}

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? API_ORIGIN
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
  process.env.DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS = String(TEST_ACCESS_TOKEN_TTL_SECONDS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function serializedConsoleErrors(errors: unknown[][]) {
  return errors
    .flat()
    .map((entry) => {
      const serialized = typeof entry === "string" ? entry : JSON.stringify(entry)
      return serialized ?? ""
    })
    .join(" ")
}

function requiredString(value: unknown, key: string) {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`OAuth response did not include ${key}`)
  }
  return value[key]
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

function hashStoredOAuthToken(token: string) {
  return createHash("sha256").update(token).digest("base64url")
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

class HarnessOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = REDIRECT_URI
  readonly clientMetadata = {
    redirect_uris: [REDIRECT_URI],
    client_name: "OpenCode MCP refresh lifecycle harness",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: MCP_SCOPE,
  }
  readonly savedTokens: OAuthTokens[] = []
  private clientInformationValue: OAuthClientInformationMixed
  private tokensValue: OAuthTokens
  private codeVerifierValue: string | undefined
  private discoveryStateValue: OAuthDiscoveryState | undefined

  constructor(input: { clientInformation: OAuthClientInformationMixed; tokens: OAuthTokens }) {
    this.clientInformationValue = input.clientInformation
    this.tokensValue = input.tokens
  }

  state(): string {
    return "mcp-refresh-lifecycle-state"
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.clientInformationValue
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.clientInformationValue = clientInformation
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.tokensValue
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokensValue = tokens
    this.savedTokens.push(tokens)
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    throw new Error(`Browser authorization was not expected in the refresh lifecycle harness: ${authorizationUrl.toString()}`)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (!this.codeVerifierValue) {
      throw new Error("OAuth code verifier was not saved")
    }
    return this.codeVerifierValue
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.discoveryStateValue
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discoveryStateValue = state
  }
}

const childTest = RUN_REFRESH_LIFECYCLE_CHILD ? test : test.skip

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let setMcpSessionLivenessDependenciesForTest: typeof import("../src/mcp/session-liveness.js").setMcpSessionLivenessDependenciesForTest
let setMcpGrantLivenessDependenciesForTest: typeof import("../src/mcp/grant-liveness.js").setMcpGrantLivenessDependenciesForTest

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const oauthClientIds: string[] = []
const sessionIds: string[] = []

beforeAll(async () => {
  if (!RUN_REFRESH_LIFECYCLE_CHILD) return
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const modules = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/mcp/session-liveness.js"),
    import("../src/mcp/grant-liveness.js"),
  ])
  app = modules[0].default
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  setMcpSessionLivenessDependenciesForTest = modules[4].setMcpSessionLivenessDependenciesForTest
  setMcpGrantLivenessDependenciesForTest = modules[5].setMcpGrantLivenessDependenciesForTest

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "MCP Refresh Lifecycle User",
    email: `mcp-refresh-lifecycle+${userId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "MCP Refresh Lifecycle Org",
    slug: `mcp-refresh-lifecycle-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "owner",
  })
})

afterAll(async () => {
  if (!RUN_REFRESH_LIFECYCLE_CHILD) return
  for (const clientId of oauthClientIds) {
    await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.clientId, clientId))
    await db.delete(schema.OAuthRefreshTokenTable).where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
    await db.delete(schema.OAuthConsentTable).where(drizzle.eq(schema.OAuthConsentTable.clientId, clientId))
    await db.delete(schema.OAuthClientTable).where(drizzle.eq(schema.OAuthClientTable.clientId, clientId))
  }
  for (const sessionId of sessionIds) {
    await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
  }
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, memberId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  mock.restore()
})

async function createSession() {
  const sessionId = createDenTypeId("session")
  const sessionToken = `mcp-refresh-lifecycle-session-${sessionId}`
  await db.insert(schema.AuthSessionTable).values({
    id: sessionId,
    userId,
    activeOrganizationId: organizationId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  sessionIds.push(sessionId)
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) throw new Error("BETTER_AUTH_SECRET is required")
  const sessionCookie = await serializeSignedCookie(
    "better-auth.session_token",
    sessionToken,
    betterAuthSecret,
  )
  return { sessionId, sessionCookie }
}

async function registerOAuthClient() {
  const clientId = `client_${createDenTypeId("oauthClient")}`
  await db.insert(schema.OAuthClientTable).values({
    id: createDenTypeId("oauthClient"),
    clientId,
    name: "MCP refresh lifecycle integration test",
    redirectUris: JSON.stringify([REDIRECT_URI]),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
    tokenEndpointAuthMethod: "none",
    grantTypes: JSON.stringify(["authorization_code", "refresh_token"]),
    responseTypes: JSON.stringify(["code"]),
    public: true,
    requirePKCE: true,
  })
  oauthClientIds.push(clientId)
  return clientId
}

async function issueOAuthGrant() {
  const { sessionId, sessionCookie } = await createSession()
  const clientId = await registerOAuthClient()

  const verifier = `mcp-refresh-lifecycle-verifier-${createDenTypeId("verification")}`
  const authorizeUrl = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  authorizeUrl.searchParams.set("client_id", clientId)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI)
  authorizeUrl.searchParams.set("scope", MCP_SCOPE)
  authorizeUrl.searchParams.set("resource", AGENT_RESOURCE)
  authorizeUrl.searchParams.set("code_challenge", codeChallenge(verifier))
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set("prompt", "consent")

  const authorizeResponse = await app.fetch(new Request(authorizeUrl, {
    headers: { cookie: sessionCookie },
  }))
  expect(authorizeResponse.status).toBe(302)
  const consentLocation = authorizeResponse.headers.get("location")
  expect(consentLocation).toBeTruthy()
  if (!consentLocation) throw new Error("Authorize response did not redirect to consent")
  const oauthQuery = new URL(consentLocation).search.replace(/^\?/, "")

  const consentResponse = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({ accept: true, scope: MCP_SCOPE, oauth_query: oauthQuery }),
  }))
  expect(consentResponse.status).toBe(200)
  const consent: unknown = await consentResponse.json()
  const callbackUrl = new URL(requiredString(consent, "url"))
  const code = callbackUrl.searchParams.get("code")
  expect(code).toBeTruthy()
  if (!code) throw new Error("Consent response did not include an authorization code")

  const tokenResponse = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: API_ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: AGENT_RESOURCE,
    }),
  }))
  const tokenBody: unknown = await tokenResponse.json()
  if (tokenResponse.status !== 200) {
    throw new Error(JSON.stringify({ callbackUrl: callbackUrl.toString(), tokenBody }))
  }
  const tokens = OAuthTokensSchema.parse(tokenBody)
  expect(tokens.expires_in).toBe(TEST_ACCESS_TOKEN_TTL_SECONDS)
  if (!tokens.refresh_token) throw new Error("Authorization-code exchange did not issue a refresh token")

  return {
    sessionId,
    clientInformation: { client_id: clientId },
    tokens,
  }
}

async function issueRefreshGrantWithoutSession() {
  const clientId = await registerOAuthClient()
  const refreshTokenSecret = `mcp-null-session-refresh-${createDenTypeId("verification")}`
  await db.insert(schema.OAuthRefreshTokenTable).values({
    id: createDenTypeId("oauthRefreshToken"),
    token: hashStoredOAuthToken(refreshTokenSecret),
    clientId,
    userId,
    referenceId: organizationId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
  })
  return {
    clientId,
    refreshToken: `ow_mcp_rt_${refreshTokenSecret}`,
  }
}

async function refreshOAuthToken(input: { clientId: string; refreshToken: string }) {
  const response = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: API_ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: AGENT_RESOURCE,
    }),
  }))
  return { status: response.status, body: await response.json() }
}

async function fetchAgentToolsWithAccessToken(accessToken: string, id: string) {
  return app.fetch(new Request(AGENT_RESOURCE, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  }))
}

function requireRefreshToken(tokens: OAuthTokens) {
  if (!tokens.refresh_token) {
    throw new Error("Expected OAuth tokens to include a refresh token")
  }
  return tokens.refresh_token
}

const denFetch: typeof fetch = (input, init) => app.fetch(new Request(input, init))

async function connectMcpClient(provider: HarnessOAuthProvider, fetchImpl: typeof fetch = denFetch) {
  const transport = new StreamableHTTPClientTransport(new URL(AGENT_RESOURCE), {
    authProvider: provider,
    fetch: fetchImpl,
  })
  const client = new Client({ name: "opencode-refresh-harness", version: "0.0.0" }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}

async function expectAgentTools(client: Client) {
  const tools = await client.listTools()
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["create_skill", "execute_capability", "search_capabilities"])
}

childTest("SDK MCP client survives multiple serial access-token refresh and replay cycles", async () => {
  const grant = await issueOAuthGrant()
  const provider = new HarnessOAuthProvider(grant)
  const session = await connectMcpClient(provider)
  try {
    await expectAgentTools(session.client)

    await sleep(ACCESS_TOKEN_EXPIRY_WAIT_MS)
    await expectAgentTools(session.client)

    await sleep(ACCESS_TOKEN_EXPIRY_WAIT_MS)
    await expectAgentTools(session.client)

    expect(provider.savedTokens).toHaveLength(2)
    expect(provider.savedTokens.every((tokens) => tokens.expires_in === TEST_ACCESS_TOKEN_TTL_SECONDS)).toBe(true)
    expect(new Set(provider.savedTokens.map((tokens) => requireRefreshToken(tokens))).size).toBe(2)
  } finally {
    await session.client.close()
  }
}, 12_000)

childTest("refresh_token grant with a live backing session still rotates", async () => {
  const grant = await issueOAuthGrant()
  const refresh = await refreshOAuthToken({
    clientId: grant.clientInformation.client_id,
    refreshToken: requireRefreshToken(grant.tokens),
  })

  expect(refresh.status).toBe(200)
  const tokens = OAuthTokensSchema.parse(refresh.body)
  expect(tokens.access_token).toBeTruthy()
  expect(requireRefreshToken(tokens)).toStartWith("ow_mcp_rt_")
}, 8_000)

childTest("refresh_token grant with a deleted backing session still rotates while consent is live", async () => {
  const grant = await issueOAuthGrant()
  const clientId = grant.clientInformation.client_id
  await db.insert(schema.OAuthAccessTokenTable).values({
    id: createDenTypeId("oauthAccessToken"),
    token: hashStoredOAuthToken(`dead-session-access-${grant.sessionId}`),
    clientId,
    sessionId: grant.sessionId,
    userId,
    referenceId: organizationId,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
  })
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, grant.sessionId))

  const refresh = await refreshOAuthToken({
    clientId,
    refreshToken: requireRefreshToken(grant.tokens),
  })

  expect(refresh.status).toBe(200)
  const tokens = OAuthTokensSchema.parse(refresh.body)
  expect(tokens.access_token).toBeTruthy()
  expect(requireRefreshToken(tokens)).toStartWith("ow_mcp_rt_")

  const refreshGrants = await db
    .select({ id: schema.OAuthRefreshTokenTable.id })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.sessionId, grant.sessionId))
  const accessGrants = await db
    .select({ id: schema.OAuthAccessTokenTable.id })
    .from(schema.OAuthAccessTokenTable)
    .where(drizzle.eq(schema.OAuthAccessTokenTable.sessionId, grant.sessionId))
  expect(refreshGrants.length).toBeGreaterThan(0)
  expect(accessGrants.length).toBeGreaterThan(0)
}, 8_000)

childTest("refresh_token grant with an expired backing session still rotates while consent is live", async () => {
  const grant = await issueOAuthGrant()
  await db.update(schema.AuthSessionTable)
    .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
    .where(drizzle.eq(schema.AuthSessionTable.id, grant.sessionId))

  const refresh = await refreshOAuthToken({
    clientId: grant.clientInformation.client_id,
    refreshToken: requireRefreshToken(grant.tokens),
  })

  expect(refresh.status).toBe(200)
  expect(OAuthTokensSchema.parse(refresh.body).access_token).toBeTruthy()
}, 8_000)

childTest("refresh_token grant with a dead session and deleted consent returns invalid_grant and clears the grant family", async () => {
  const grant = await issueOAuthGrant()
  const clientId = grant.clientInformation.client_id
  await db.insert(schema.OAuthAccessTokenTable).values({
    id: createDenTypeId("oauthAccessToken"),
    token: hashStoredOAuthToken(`revoked-consent-access-${grant.sessionId}`),
    clientId,
    sessionId: grant.sessionId,
    userId,
    referenceId: organizationId,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
  })
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, grant.sessionId))
  await db.delete(schema.OAuthConsentTable).where(drizzle.eq(schema.OAuthConsentTable.clientId, clientId))

  const refresh = await refreshOAuthToken({
    clientId,
    refreshToken: requireRefreshToken(grant.tokens),
  })

  expect(refresh.status).toBe(400)
  if (!isRecord(refresh.body)) throw new Error("Expected OAuth error response body")
  expect(refresh.body.error).toBe("invalid_grant")
  expect(refresh.body.access_token).toBeUndefined()
  expect(refresh.body.refresh_token).toBeUndefined()

  const refreshGrants = await db
    .select({ id: schema.OAuthRefreshTokenTable.id })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.sessionId, grant.sessionId))
  const accessGrants = await db
    .select({ id: schema.OAuthAccessTokenTable.id })
    .from(schema.OAuthAccessTokenTable)
    .where(drizzle.eq(schema.OAuthAccessTokenTable.sessionId, grant.sessionId))
  expect(refreshGrants).toHaveLength(0)
  expect(accessGrants).toHaveLength(0)
}, 8_000)

childTest("refresh_token grant with no session_id remains valid", async () => {
  const grant = await issueRefreshGrantWithoutSession()
  const refresh = await refreshOAuthToken({
    clientId: grant.clientId,
    refreshToken: grant.refreshToken,
  })

  expect(refresh.status).toBe(200)
  const tokens = OAuthTokensSchema.parse(refresh.body)
  expect(tokens.access_token).toBeTruthy()
  expect(requireRefreshToken(tokens)).toStartWith("ow_mcp_rt_")
}, 8_000)

childTest("authorization_code grant path still issues session-bound refresh tokens", async () => {
  const grant = await issueOAuthGrant()
  const clientId = grant.clientInformation.client_id
  expect(grant.tokens.access_token).toBeTruthy()
  expect(requireRefreshToken(grant.tokens)).toStartWith("ow_mcp_rt_")

  const [refreshGrant] = await db
    .select({ sessionId: schema.OAuthRefreshTokenTable.sessionId })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
    .limit(1)
  expect(refreshGrant?.sessionId).toBe(grant.sessionId)
}, 8_000)

childTest("session liveness check failures 503 resource requests but fail open refresh grants", async () => {
  const grant = await issueOAuthGrant()
  const clientId = grant.clientInformation.client_id
  const failOpenAccessSecret = `fail-open-access-${grant.sessionId}`
  await db.insert(schema.OAuthAccessTokenTable).values({
    id: createDenTypeId("oauthAccessToken"),
    token: hashStoredOAuthToken(failOpenAccessSecret),
    clientId: "openwork-desktop",
    sessionId: grant.sessionId,
    userId,
    referenceId: organizationId,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
  })
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  const restoreLiveness = setMcpSessionLivenessDependenciesForTest({
    select: async () => {
      throw new Error("simulated liveness select outage")
    },
  })

  try {
    const response = await fetchAgentToolsWithAccessToken(`ow_mcp_at_${failOpenAccessSecret}`, "liveness-check-failed")
    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
    expect(response.headers.get("retry-after")).toBe("10")
    const body: unknown = await response.json()
    expect(isRecord(body) && body.error).toBe("mcp_session_check_unavailable")

    const refresh = await refreshOAuthToken({
      clientId,
      refreshToken: requireRefreshToken(grant.tokens),
    })
    expect(refresh.status).toBe(200)
    expect(OAuthTokensSchema.parse(refresh.body).access_token).toBeTruthy()
  } finally {
    restoreLiveness()
    console.error = originalError
  }

  expect(serializedConsoleErrors(errors)).toContain("mcp_session_liveness_check_failed")
  const refreshGrants = await db
    .select({ id: schema.OAuthRefreshTokenTable.id })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.sessionId, grant.sessionId))
  const accessGrants = await db
    .select({ id: schema.OAuthAccessTokenTable.id })
    .from(schema.OAuthAccessTokenTable)
    .where(drizzle.eq(schema.OAuthAccessTokenTable.sessionId, grant.sessionId))
  expect(refreshGrants.length).toBeGreaterThan(0)
  expect(accessGrants.length).toBeGreaterThan(0)
}, 8_000)

childTest("grant liveness accepts cached consent-id checks", async () => {
  const grant = await issueOAuthGrant()
  const provider = new HarnessOAuthProvider(grant)
  const [consent] = await db
    .select({ id: schema.OAuthConsentTable.id })
    .from(schema.OAuthConsentTable)
    .where(drizzle.eq(schema.OAuthConsentTable.clientId, grant.clientInformation.client_id))
    .limit(1)
  if (!consent) throw new Error("OAuth grant did not create consent")
  let selectCount = 0
  const restoreLiveness = setMcpGrantLivenessDependenciesForTest({
    select: async () => {
      selectCount += 1
      return [{ id: consent.id }]
    },
  })

  let session: Awaited<ReturnType<typeof connectMcpClient>> | null = null
  try {
    session = await connectMcpClient(provider)
    await expectAgentTools(session.client)
  } finally {
    await session?.client.close()
    restoreLiveness()
  }

  expect(selectCount).toBeGreaterThan(0)
}, 8_000)

type RefreshRecord = {
  refreshToken: string | null
  status: number
  body: unknown
}

function createConcurrentRefreshFetch(records: RefreshRecord[]): typeof fetch {
  let arrivals = 0
  let released = false
  let release: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const releaseOnce = () => {
    if (released) return
    released = true
    if (timeout) clearTimeout(timeout)
    release()
  }
  timeout = setTimeout(releaseOnce, 3_000)

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/api/auth/oauth2/token" && request.method === "POST") {
      const params = new URLSearchParams(await request.clone().text())
      if (params.get("grant_type") === "refresh_token") {
        arrivals += 1
        if (arrivals === 2) releaseOnce()
        await ready
        const response = await app.fetch(request)
        records.push({
          refreshToken: params.get("refresh_token"),
          status: response.status,
          body: await response.clone().json().catch(() => null),
        })
        return response
      }
    }
    return app.fetch(request)
  }
}

childTest("two concurrent SDK requests after access expiry recover during refresh rotation grace", async () => {
  const grant = await issueOAuthGrant()
  const firstRefreshToken = requireRefreshToken(grant.tokens)
  const provider = new HarnessOAuthProvider(grant)
  const refreshRecords: RefreshRecord[] = []
  const fetchImpl = createConcurrentRefreshFetch(refreshRecords)
  const first = await connectMcpClient(provider, fetchImpl)
  const second = await connectMcpClient(provider, fetchImpl)
  try {
    await sleep(ACCESS_TOKEN_EXPIRY_WAIT_MS)
    const results = await Promise.allSettled([
      first.client.listTools(),
      second.client.listTools(),
    ])

    const statuses = refreshRecords.map((record) => record.status)
    const firstRefreshAttempts = refreshRecords.slice(0, 2)
    const rotatedRefreshTokens: string[] = []
    for (const record of firstRefreshAttempts) {
      const parsed = OAuthTokensSchema.safeParse(record.body)
      expect(parsed.success).toBe(true)
      if (parsed.success) rotatedRefreshTokens.push(requireRefreshToken(parsed.data))
    }
    expect(refreshRecords.length).toBeGreaterThanOrEqual(2)
    expect(firstRefreshAttempts.map((record) => record.refreshToken)).toEqual([firstRefreshToken, firstRefreshToken])
    expect(statuses.every((status) => status >= 200 && status < 300)).toBe(true)
    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    expect(rotatedRefreshTokens).not.toContain(firstRefreshToken)
    expect(new Set(rotatedRefreshTokens).size).toBe(rotatedRefreshTokens.length)
    const savedRefreshTokens = provider.savedTokens.map((tokens) => requireRefreshToken(tokens))
    expect(savedRefreshTokens.length).toBeGreaterThanOrEqual(2)
    expect(savedRefreshTokens).not.toContain(firstRefreshToken)
    expect(new Set(savedRefreshTokens).size).toBe(savedRefreshTokens.length)
  } finally {
    await first.client.close()
    await second.client.close()
  }
}, 12_000)

childTest("reusing a rotated refresh token within grace succeeds, but stale replay revokes the token family", async () => {
  const grant = await issueOAuthGrant()
  const clientId = grant.clientInformation.client_id
  const firstRefreshToken = requireRefreshToken(grant.tokens)
  const [originalGrant] = await db
    .select({ id: schema.OAuthRefreshTokenTable.id })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
    .limit(1)
  expect(originalGrant).toBeDefined()
  if (!originalGrant) throw new Error("Authorization-code exchange did not store the original refresh grant")

  const rotated = await refreshOAuthToken({ clientId, refreshToken: firstRefreshToken })
  expect(rotated.status).toBe(200)
  const rotatedTokens = OAuthTokensSchema.parse(rotated.body)
  const rotatedRefreshToken = requireRefreshToken(rotatedTokens)
  expect(rotatedRefreshToken).not.toBe(firstRefreshToken)

  const replayWithinGrace = await refreshOAuthToken({ clientId, refreshToken: firstRefreshToken })
  expect(replayWithinGrace.status).toBe(200)
  const graceTokens = OAuthTokensSchema.parse(replayWithinGrace.body)
  const graceRefreshToken = requireRefreshToken(graceTokens)
  expect(graceRefreshToken).not.toBe(firstRefreshToken)
  expect(graceRefreshToken).not.toBe(rotatedRefreshToken)

  const grantsAfterGraceReplay = await db
    .select({ revoked: schema.OAuthRefreshTokenTable.revoked })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
  expect(grantsAfterGraceReplay.filter((refreshGrant) => refreshGrant.revoked === null).length).toBeGreaterThan(0)

  await db.update(schema.OAuthRefreshTokenTable)
    .set({ revoked: new Date(Date.now() - 31_000) })
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.id, originalGrant.id))

  const staleReplay = await refreshOAuthToken({ clientId, refreshToken: firstRefreshToken })
  expect(staleReplay.status).toBe(400)
  expect(isRecord(staleReplay.body) && staleReplay.body.error).toBe("invalid_grant")

  const grants = await db
    .select({ id: schema.OAuthRefreshTokenTable.id })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
  expect(grants).toHaveLength(0)

  for (const successor of [rotatedRefreshToken, graceRefreshToken]) {
    const replaySuccessor = await refreshOAuthToken({ clientId, refreshToken: successor })
    expect(replaySuccessor.status).toBe(400)
    expect(isRecord(replaySuccessor.body) && replaySuccessor.body.error).toBe("invalid_grant")
  }
}, 8_000)

childTest("dead sessions leave consent-bound tokens valid while sid-only tokens are rejected", async () => {
  const grant = await issueOAuthGrant()
  await db.update(schema.AuthSessionTable)
    .set({ expiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
    .where(drizzle.eq(schema.AuthSessionTable.id, grant.sessionId))

  const grantResponse = await app.fetch(new Request(AGENT_RESOURCE, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${grant.tokens.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "revoked-session", method: "tools/list", params: {} }),
  }))

  expect(grantResponse.status).toBe(200)

  const sidOnlyAccessSecret = `sid-only-access-${grant.sessionId}`
  await db.insert(schema.OAuthAccessTokenTable).values({
    id: createDenTypeId("oauthAccessToken"),
    token: hashStoredOAuthToken(sidOnlyAccessSecret),
    clientId: "openwork-desktop",
    sessionId: grant.sessionId,
    userId,
    referenceId: organizationId,
    expiresAt: new Date(Date.now() + 60_000),
    scopes: JSON.stringify(MCP_SCOPE.split(" ")),
  })
  const sidOnlyResponse = await fetchAgentToolsWithAccessToken(`ow_mcp_at_${sidOnlyAccessSecret}`, "revoked-sid-only-session")

  expect(sidOnlyResponse.status).toBe(401)
  expect(sidOnlyResponse.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"')
  const body: unknown = await sidOnlyResponse.json()
  expect(isRecord(body) && body.error).toBe("mcp_session_revoked")
}, 8_000)
