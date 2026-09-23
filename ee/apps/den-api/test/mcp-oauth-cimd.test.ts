import { createHash } from "node:crypto"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

// Client ID Metadata Documents (MCP authorization spec, draft-ietf-oauth-
// client-id-metadata-document): the client_id is the HTTPS URL of a JSON
// document the client hosts. Den fetches it through the cimd plugin instead of
// requiring dynamic client registration. The document host below is a fake
// origin served in-process by intercepting global fetch.
const API_ORIGIN = "http://127.0.0.1:8790"
const CLIENT_ORIGIN = "https://cimd-client.example.test"
const CLIENT_ID = `${CLIENT_ORIGIN}/oauth/client-metadata.json`
const MISMATCHED_CLIENT_ID = `${CLIENT_ORIGIN}/oauth/mismatched-client-metadata.json`
const FOREIGN_REDIRECT_CLIENT_ID = `${CLIENT_ORIGIN}/oauth/foreign-redirect-client-metadata.json`
const LOOPBACK_REDIRECT_URI = "http://127.0.0.1:33418/callback"
const AGENT_RESOURCE = `${API_ORIGIN}/mcp/agent`

const documents: Record<string, Record<string, unknown>> = {
  [CLIENT_ID]: {
    client_id: CLIENT_ID,
    client_name: "CIMD Test Client",
    client_uri: CLIENT_ORIGIN,
    redirect_uris: [LOOPBACK_REDIRECT_URI, `${CLIENT_ORIGIN}/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  [MISMATCHED_CLIENT_ID]: {
    client_id: CLIENT_ID,
    client_name: "Impersonating Client",
    redirect_uris: [LOOPBACK_REDIRECT_URI],
    token_endpoint_auth_method: "none",
  },
  [FOREIGN_REDIRECT_CLIENT_ID]: {
    client_id: FOREIGN_REDIRECT_CLIENT_ID,
    client_name: "Cleartext Redirect Client",
    redirect_uris: ["http://attacker.example.test/callback"],
    token_endpoint_auth_method: "none",
  },
}
const documentFetches: string[] = []

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_cimd"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function requiredString(value: unknown, key: string) {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`OAuth response did not include ${key}: ${JSON.stringify(value)}`)
  }
  return value[key]
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const sessionId = createDenTypeId("session")
const sessionToken = `mcp-cimd-session-${sessionId}`
let sessionCookie = ""
let mcpScope = ""
let refreshToken = ""
const realFetch = globalThis.fetch

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const document = documents[url]
    if (!document) return realFetch(input, init)
    documentFetches.push(url)
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  const [appMod, dbMod, schemaMod, drizzleMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod

  for (const clientId of Object.keys(documents)) {
    await db.delete(schema.OAuthClientTable).where(drizzle.eq(schema.OAuthClientTable.clientId, clientId))
  }
  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "CIMD OAuth User",
    email: `mcp-cimd+${userId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "CIMD OAuth Org",
    slug: `mcp-cimd-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "owner",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: sessionId,
    userId,
    activeOrganizationId: organizationId,
    token: sessionToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) throw new Error("BETTER_AUTH_SECRET is required")
  sessionCookie = await serializeSignedCookie("openwork-den.session_token", sessionToken, betterAuthSecret)

  const metadataResponse = await app.fetch(new Request(`${API_ORIGIN}/mcp/agent/.well-known/oauth-protected-resource`))
  expect(metadataResponse.status).toBe(200)
  const metadata: unknown = await metadataResponse.json()
  if (!isRecord(metadata) || !Array.isArray(metadata.scopes_supported)) {
    throw new Error("MCP protected-resource metadata did not include scopes_supported")
  }
  mcpScope = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")
})

afterAll(async () => {
  globalThis.fetch = realFetch
  for (const clientId of Object.keys(documents)) {
    await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.clientId, clientId))
    await db.delete(schema.OAuthRefreshTokenTable).where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, clientId))
    await db.delete(schema.OAuthConsentTable).where(drizzle.eq(schema.OAuthConsentTable.clientId, clientId))
    await db.delete(schema.OAuthClientTable).where(drizzle.eq(schema.OAuthClientTable.clientId, clientId))
  }
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, memberId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  mock.restore()
})

function authorizeUrl(input: { clientId: string; redirectUri: string; verifier?: string; prompt?: string }) {
  const url = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", mcpScope)
  url.searchParams.set("resource", AGENT_RESOURCE)
  if (input.verifier) {
    url.searchParams.set("code_challenge", codeChallenge(input.verifier))
    url.searchParams.set("code_challenge_method", "S256")
  }
  if (input.prompt) url.searchParams.set("prompt", input.prompt)
  return url
}

async function authorize(input: { clientId: string; redirectUri: string; verifier?: string; prompt?: string }) {
  return app.fetch(new Request(authorizeUrl(input), { headers: { cookie: sessionCookie } }))
}

/** Authorization failures surface either as a JSON error body or as an error redirect. */
async function readOAuthError(response: Response) {
  const location = response.headers.get("location")
  if (location) {
    const error = new URL(location).searchParams.get("error")
    if (error) return { error, location, body: null }
  }
  const body: unknown = await response.clone().json().catch(() => null)
  return { error: isRecord(body) && typeof body.error === "string" ? body.error : null, location, body }
}

test("authorization server discovery advertises client ID metadata documents next to dynamic registration", async () => {
  for (const path of ["/.well-known/oauth-authorization-server", "/api/auth/.well-known/oauth-authorization-server"]) {
    const response = await app.fetch(new Request(`${API_ORIGIN}${path}`))
    expect(response.status).toBe(200)
    const metadata: unknown = await response.json()
    expect(isRecord(metadata) && metadata.client_id_metadata_document_supported).toBe(true)
    expect(isRecord(metadata) && typeof metadata.registration_endpoint === "string").toBe(true)
  }
})

test("a URL client_id completes code + PKCE without dynamic client registration", async () => {
  const verifier = `mcp-cimd-verifier-${createDenTypeId("verification")}`
  const authorizeResponse = await authorize({ clientId: CLIENT_ID, redirectUri: LOOPBACK_REDIRECT_URI, verifier, prompt: "consent" })
  expect(authorizeResponse.status).toBe(302)
  const consentLocation = authorizeResponse.headers.get("location")
  if (!consentLocation) throw new Error("Authorize response did not redirect to consent")
  expect(new URL(consentLocation).searchParams.get("client_id")).toBe(CLIENT_ID)
  expect(documentFetches.filter((url) => url === CLIENT_ID)).toHaveLength(1)

  const [client] = await db
    .select({ clientId: schema.OAuthClientTable.clientId, name: schema.OAuthClientTable.name, isPublic: schema.OAuthClientTable.public, redirectUris: schema.OAuthClientTable.redirectUris })
    .from(schema.OAuthClientTable)
    .where(drizzle.eq(schema.OAuthClientTable.clientId, CLIENT_ID))
  expect(client).toMatchObject({ clientId: CLIENT_ID, name: "CIMD Test Client", isPublic: true })
  expect(client?.redirectUris).toContain(LOOPBACK_REDIRECT_URI)

  const oauthQuery = new URL(consentLocation).search.replace(/^\?/, "")
  const consentResponse = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie, origin: API_ORIGIN },
    body: JSON.stringify({ accept: true, scope: mcpScope, oauth_query: oauthQuery }),
  }))
  expect(consentResponse.status).toBe(200)
  const consent: unknown = await consentResponse.json()
  const callbackUrl = new URL(requiredString(consent, "url"))
  expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(LOOPBACK_REDIRECT_URI)
  const code = callbackUrl.searchParams.get("code")
  if (!code) throw new Error("Consent response did not include an authorization code")

  const tokenResponse = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: API_ORIGIN },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: LOOPBACK_REDIRECT_URI,
      resource: AGENT_RESOURCE,
    }),
  }))
  const tokens: unknown = await tokenResponse.json()
  if (tokenResponse.status !== 200) throw new Error(JSON.stringify({ callbackUrl: callbackUrl.toString(), tokens }))
  expect(requiredString(tokens, "access_token").length).toBeGreaterThan(0)
  refreshToken = requiredString(tokens, "refresh_token")
  expect(refreshToken).toStartWith("ow_mcp_rt_")
})

test("a URL client_id is recognised as an MCP client when refreshing without a resource parameter", async () => {
  expect(refreshToken).not.toBe("")
  const response = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: API_ORIGIN },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
  }))
  const tokens: unknown = await response.json()
  if (response.status !== 200) throw new Error(JSON.stringify(tokens))
  expect(requiredString(tokens, "access_token").length).toBeGreaterThan(0)
  // The cached document is reused within its refresh window.
  expect(documentFetches.filter((url) => url === CLIENT_ID)).toHaveLength(1)
})

test("a redirect URI outside the metadata document is rejected", async () => {
  const response = await authorize({ clientId: CLIENT_ID, redirectUri: "http://127.0.0.1:33418/somewhere-else", verifier: "x".repeat(43) })
  const failure = await readOAuthError(response)
  expect(failure.error).toBeTruthy()
  expect(failure.location?.includes("code=") ?? false).toBe(false)
})

test("a document whose client_id does not match its URL is rejected", async () => {
  const response = await authorize({ clientId: MISMATCHED_CLIENT_ID, redirectUri: LOOPBACK_REDIRECT_URI, verifier: "x".repeat(43) })
  const failure = await readOAuthError(response)
  expect(failure.error).toBe("invalid_client")
  const rows = await db.select({ id: schema.OAuthClientTable.id }).from(schema.OAuthClientTable)
    .where(drizzle.eq(schema.OAuthClientTable.clientId, MISMATCHED_CLIENT_ID))
  expect(rows).toHaveLength(0)
})

test("Den's MCP redirect policy still applies to metadata-document clients", async () => {
  const response = await authorize({ clientId: FOREIGN_REDIRECT_CLIENT_ID, redirectUri: "http://attacker.example.test/callback", verifier: "x".repeat(43) })
  expect(response.status).toBe(400)
  const failure = await readOAuthError(response)
  expect(failure.error).toBe("invalid_redirect_uri")
  // Rejected before any document fetch.
  expect(documentFetches).not.toContain(FOREIGN_REDIRECT_CLIENT_ID)
})
