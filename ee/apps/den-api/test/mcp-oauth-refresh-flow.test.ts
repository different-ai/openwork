import { createHash } from "node:crypto"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"
const REDIRECT_URI = "http://127.0.0.1:49152/oauth/callback"
const AGENT_RESOURCE = `${API_ORIGIN}/mcp/agent`
const LEGACY_PARENT_RESOURCE = `${API_ORIGIN}/mcp`
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
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
    throw new Error(`OAuth response did not include ${key}`)
  }
  return value[key]
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const sessionId = createDenTypeId("session")
const sessionToken = `mcp-refresh-session-${sessionId}`
let sessionCookie = ""
let oauthClientId = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

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

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "MCP Refresh Flow User",
    email: `mcp-refresh-flow+${userId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "MCP Refresh Flow Org",
    slug: `mcp-refresh-flow-${organizationId}`,
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
  sessionCookie = await serializeSignedCookie(
    "better-auth.session_token",
    sessionToken,
    betterAuthSecret,
  )
})

afterAll(async () => {
  if (oauthClientId) {
    await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.clientId, oauthClientId))
    await db.delete(schema.OAuthRefreshTokenTable).where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, oauthClientId))
    await db.delete(schema.OAuthConsentTable).where(drizzle.eq(schema.OAuthConsentTable.clientId, oauthClientId))
    await db.delete(schema.OAuthClientTable).where(drizzle.eq(schema.OAuthClientTable.clientId, oauthClientId))
  }
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, memberId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  mock.restore()
})

test("legacy MCP registration gains offline access and rotates a thirty-day refresh grant", async () => {
  const metadataResponse = await app.fetch(new Request(`${API_ORIGIN}/mcp/agent/.well-known/oauth-protected-resource`))
  expect(metadataResponse.status).toBe(200)
  const metadata: unknown = await metadataResponse.json()
  expect(isRecord(metadata) && Array.isArray(metadata.scopes_supported)).toBe(true)
  if (!isRecord(metadata) || !Array.isArray(metadata.scopes_supported)) {
    throw new Error("MCP protected-resource metadata did not include scopes_supported")
  }
  expect(metadata.resource).toBe(AGENT_RESOURCE)
  const scopes = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string")
  expect(scopes).toContain("offline_access")
  const scope = scopes.join(" ")
  const legacyScope = "mcp:read"

  const registrationResponse = await app.fetch(new Request(`${API_ORIGIN}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: API_ORIGIN,
    },
    body: JSON.stringify({
      client_name: "MCP refresh integration test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: legacyScope,
    }),
  }))
  expect(registrationResponse.status).toBe(200)
  const registration: unknown = await registrationResponse.json()
  oauthClientId = requiredString(registration, "client_id")
  expect(requiredString(registration, "scope")).toBe(legacyScope)

  const verifier = `mcp-refresh-verifier-${createDenTypeId("verification")}`
  const authorizeUrl = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  authorizeUrl.searchParams.set("client_id", oauthClientId)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI)
  authorizeUrl.searchParams.set("scope", scope)
  authorizeUrl.searchParams.set("resource", LEGACY_PARENT_RESOURCE)
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
    body: JSON.stringify({ accept: true, scope, oauth_query: oauthQuery }),
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
      client_id: oauthClientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: LEGACY_PARENT_RESOURCE,
    }),
  }))
  const tokens: unknown = await tokenResponse.json()
  if (tokenResponse.status !== 200) {
    throw new Error(JSON.stringify({ callbackUrl: callbackUrl.toString(), tokens }))
  }
  expect({ status: tokenResponse.status, tokens }).toMatchObject({ status: 200 })
  const firstRefreshToken = requiredString(tokens, "refresh_token")
  const grantedScopes = requiredString(tokens, "scope").split(" ")
  expect(firstRefreshToken).toStartWith("ow_mcp_rt_")
  expect(isRecord(tokens) && tokens.expires_in).toBe(15 * 60)
  expect(grantedScopes).toContain("offline_access")
  expect(grantedScopes).toContain("mcp:write")

  const [firstGrant] = await db
    .select({
      id: schema.OAuthRefreshTokenTable.id,
      createdAt: schema.OAuthRefreshTokenTable.createdAt,
      expiresAt: schema.OAuthRefreshTokenTable.expiresAt,
      revoked: schema.OAuthRefreshTokenTable.revoked,
    })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, oauthClientId))
    .limit(1)
  expect(firstGrant).toBeDefined()
  if (!firstGrant) throw new Error("Authorization-code exchange did not store a refresh grant")
  expect(firstGrant.revoked).toBeNull()
  expect(firstGrant.expiresAt.getTime() - firstGrant.createdAt.getTime()).toBe(THIRTY_DAYS_MS)

  const refreshResponse = await app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: API_ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oauthClientId,
      refresh_token: firstRefreshToken,
      resource: LEGACY_PARENT_RESOURCE,
    }),
  }))
  expect(refreshResponse.status).toBe(200)
  const refreshed: unknown = await refreshResponse.json()
  const nextRefreshToken = requiredString(refreshed, "refresh_token")
  expect(nextRefreshToken).toStartWith("ow_mcp_rt_")
  expect(nextRefreshToken).not.toBe(firstRefreshToken)

  const grants = await db
    .select({
      id: schema.OAuthRefreshTokenTable.id,
      createdAt: schema.OAuthRefreshTokenTable.createdAt,
      expiresAt: schema.OAuthRefreshTokenTable.expiresAt,
      revoked: schema.OAuthRefreshTokenTable.revoked,
    })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, oauthClientId))
  expect(grants).toHaveLength(2)
  expect(grants.find((grant) => grant.id === firstGrant.id)?.revoked).toBeInstanceOf(Date)
  const activeGrant = grants.find((grant) => grant.revoked === null)
  expect(activeGrant).toBeDefined()
  if (!activeGrant) throw new Error("Refresh rotation did not store a replacement grant")
  expect(activeGrant.expiresAt.getTime() - activeGrant.createdAt.getTime()).toBe(THIRTY_DAYS_MS)

  const concurrentRefreshRequest = () => app.fetch(new Request(`${API_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: API_ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oauthClientId,
      refresh_token: nextRefreshToken,
      resource: LEGACY_PARENT_RESOURCE,
    }),
  }))
  const concurrentResponses = await Promise.all([concurrentRefreshRequest(), concurrentRefreshRequest()])
  const concurrentStatuses = concurrentResponses.map((response) => response.status).sort()
  expect(concurrentStatuses).toEqual([200, 400])
  expect(concurrentStatuses).not.toContain(500)
  const concurrentErrors = await Promise.all(concurrentResponses
    .filter((response) => response.status !== 200)
    .map((response) => response.json()))
  expect(concurrentErrors).toHaveLength(1)
  expect(isRecord(concurrentErrors[0]) && concurrentErrors[0].error).toBe("invalid_grant")

  const grantsAfterConcurrentReplay = await db
    .select({
      id: schema.OAuthRefreshTokenTable.id,
      revoked: schema.OAuthRefreshTokenTable.revoked,
    })
    .from(schema.OAuthRefreshTokenTable)
    .where(drizzle.eq(schema.OAuthRefreshTokenTable.clientId, oauthClientId))
  expect(grantsAfterConcurrentReplay.filter((grant) => grant.revoked === null)).toEqual([])

  const overbroadAuthorizeUrl = new URL(authorizeUrl)
  overbroadAuthorizeUrl.searchParams.set("scope", `${scope} email`)
  const overbroadResponse = await app.fetch(new Request(overbroadAuthorizeUrl, {
    headers: { cookie: sessionCookie },
  }))
  expect(overbroadResponse.status).toBe(302)
  const overbroadCallback = new URL(overbroadResponse.headers.get("location") ?? REDIRECT_URI)
  expect(overbroadCallback.searchParams.get("error")).toBe("invalid_scope")
  expect(overbroadCallback.searchParams.get("error_description")).toContain("email")
})
