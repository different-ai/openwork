import { createHash } from "node:crypto"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"
const CURSOR_DESKTOP_REDIRECT_URI = "cursor://anysphere.cursor-mcp/oauth/callback"
const AGENT_RESOURCE = `${API_ORIGIN}/mcp/agent`

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_cursor_desktop"
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
const sessionToken = `mcp-cursor-desktop-session-${sessionId}`
let sessionCookie = ""
let oauthClientId = ""
let mcpScope = ""

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
    name: "Cursor Desktop OAuth User",
    email: `mcp-cursor-desktop+${userId}@test.local`,
    emailVerified: true,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Cursor Desktop OAuth Org",
    slug: `mcp-cursor-desktop-${organizationId}`,
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

test("Cursor Desktop registration is accepted on the private-use callback", async () => {
  const metadataResponse = await app.fetch(new Request(`${API_ORIGIN}/mcp/agent/.well-known/oauth-protected-resource`))
  expect(metadataResponse.status).toBe(200)
  const metadata: unknown = await metadataResponse.json()
  if (!isRecord(metadata) || !Array.isArray(metadata.scopes_supported)) {
    throw new Error("MCP protected-resource metadata did not include scopes_supported")
  }
  mcpScope = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")

  const registrationResponse = await app.fetch(new Request(`${API_ORIGIN}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: API_ORIGIN,
    },
    body: JSON.stringify({
      client_name: "Cursor",
      redirect_uris: [CURSOR_DESKTOP_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }))
  expect(registrationResponse.status).toBe(200)
  const registration: unknown = await registrationResponse.json()
  oauthClientId = requiredString(registration, "client_id")
  expect(isRecord(registration) && Array.isArray(registration.redirect_uris) && registration.redirect_uris[0]).toBe(CURSOR_DESKTOP_REDIRECT_URI)
})

// Dynamic client registration cannot set require_pkce, and the OAuth provider
// requires PKCE for public clients and defaults require_pkce on for everything
// else, so a private-use callback can never skip PKCE.
test("Cursor Desktop authorize without PKCE is rejected on the private-use callback", async () => {
  const authorizeUrl = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  authorizeUrl.searchParams.set("client_id", oauthClientId)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("redirect_uri", CURSOR_DESKTOP_REDIRECT_URI)
  authorizeUrl.searchParams.set("scope", mcpScope)
  authorizeUrl.searchParams.set("resource", AGENT_RESOURCE)

  const authorizeResponse = await app.fetch(new Request(authorizeUrl, {
    headers: { cookie: sessionCookie },
  }))
  expect(authorizeResponse.status).toBe(302)
  const location = authorizeResponse.headers.get("location")
  expect(location).toBeTruthy()
  if (!location) throw new Error("Authorize response did not redirect")
  expect(location.startsWith(`${CURSOR_DESKTOP_REDIRECT_URI}?`)).toBe(true)
  expect(new URL(location).searchParams.get("error")).toBe("invalid_request")
})

test("Cursor Desktop completes the full code + PKCE exchange on the private-use callback", async () => {
  const verifier = `mcp-cursor-desktop-verifier-${createDenTypeId("verification")}`
  const authorizeUrl = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  authorizeUrl.searchParams.set("client_id", oauthClientId)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("redirect_uri", CURSOR_DESKTOP_REDIRECT_URI)
  authorizeUrl.searchParams.set("scope", mcpScope)
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
    body: JSON.stringify({ accept: true, scope: mcpScope, oauth_query: oauthQuery }),
  }))
  expect(consentResponse.status).toBe(200)
  const consent: unknown = await consentResponse.json()
  const callbackUrl = new URL(requiredString(consent, "url"))
  expect(callbackUrl.protocol).toBe("cursor:")
  expect(callbackUrl.host).toBe("anysphere.cursor-mcp")
  expect(callbackUrl.pathname).toBe("/oauth/callback")
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
      redirect_uri: CURSOR_DESKTOP_REDIRECT_URI,
      resource: AGENT_RESOURCE,
    }),
  }))
  const tokens: unknown = await tokenResponse.json()
  if (tokenResponse.status !== 200) {
    throw new Error(JSON.stringify({ callbackUrl: callbackUrl.toString(), tokens }))
  }
  expect(requiredString(tokens, "access_token").length).toBeGreaterThan(0)
  expect(requiredString(tokens, "refresh_token")).toStartWith("ow_mcp_rt_")
})
