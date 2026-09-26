import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose"

const API_ORIGIN = "http://127.0.0.1:8790"
const PROXY_BASE_URL = "https://inference.example.test"
const OAUTH_CLIENT_ID = "vertex-client.apps.googleusercontent.com"
const OAUTH_CLIENT_SECRET = "GOCSPX-vertex-client-secret"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

function seedRequiredEnv() {
  const databaseUrl = process.env.DEN_TEST_DATABASE_URL
  if (!databaseUrl) throw new Error("Set DEN_TEST_DATABASE_URL to an isolated prepared test database; ambient DATABASE_URL is not used")
  process.env.DATABASE_URL = databaseUrl
  process.env.DB_MODE = "mysql"
  process.env.NODE_ENV = "test"
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = "w".repeat(32)
  process.env.BETTER_AUTH_URL = API_ORIGIN
  process.env.DEN_BASE_URL = API_ORIGIN
  process.env.CORS_ORIGINS = API_ORIGIN
  process.env.GATEWAY_ENABLED = "true"
  process.env.GATEWAY_PROXY_BASE_URL = PROXY_BASE_URL
  process.env.GATEWAY_PUBLIC_BASE_URL = PROXY_BASE_URL
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readProvider(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.inferenceProvider)) {
    throw new Error("Response did not include inferenceProvider")
  }
  return payload.inferenceProvider
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`${key} was not a string`)
  return value
}

function readRows(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${key} was not an object array`)
  return value
}

function defaultSet(provider: Record<string, unknown>) {
  if (!Array.isArray(provider.credentialSets) || !isRecord(provider.credentialSets[0])) throw new Error("credentialSets missing")
  return provider.credentialSets[0]
}

async function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("cookie", cookie)
  headers.set("origin", API_ORIGIN)
  if (init.body) headers.set("content-type", "application/json")
  const response = await app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers, redirect: "manual" }))
  if (!path.includes("/oauth/start") || !response.ok && response.status !== 302) return response
  const payload: unknown = response.status === 200 ? await response.json() : null
  const entry = new URL(response.status === 302 ? response.headers.get("location") ?? "" : isRecord(payload) ? readString(payload, "authUrl") : "")
  expect(entry.pathname).toBe("/gateway/connect")
  const attempt = entry.searchParams.get("attempt") ?? ""
  return publicRequest(`/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`, headers)
}

function publicRequest(path: string, headers?: HeadersInit) {
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { headers, redirect: "manual" }))
}

function browserRequest(path: string, cookie = memberCookie) {
  // A top-level callback navigation carries cookies, not Desktop's bearer or Origin.
  return publicRequest(path, { cookie })
}

const vertexCatalog = {
  id: "google-vertex",
  name: "Vertex",
  npm: "@ai-sdk/google-vertex",
  env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
  doc: null,
  api: null,
  config: { id: "google-vertex", npm: "@ai-sdk/google-vertex" },
  models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", config: { id: "gemini-2.5-pro" } }],
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/cloud-platform"
const googleKeyPair = generateKeyPair("RS256")
const googlePublicJwk = googleKeyPair.then(async ({ publicKey }) => ({ ...await exportJWK(publicKey), kid: "fixture-google", alg: "RS256", use: "sig" }))

type GoogleCall = { url: string; body: URLSearchParams }

async function googleIdToken(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ iss: "https://accounts.google.com", aud: OAUTH_CLIENT_ID, sub: "fixture-google-subject", email: "google-account@example.test", email_verified: true, iat: now, exp: now + 3600, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-google" })
    .sign((await googleKeyPair).privateKey)
}

/** Replaces global fetch for Google's token/revoke endpoints; everything else fails loudly. */
function withFakeGoogle<T>(
  handler: (call: GoogleCall) => Response | Promise<Response>,
  run: (calls: GoogleCall[]) => Promise<T>,
) {
  const calls: GoogleCall[] = []
  const realFetch = globalThis.fetch
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === GOOGLE_JWKS_URL) return Response.json({ keys: [await googlePublicJwk] })
    if (url !== GOOGLE_TOKEN_URL && url !== GOOGLE_REVOKE_URL) {
      throw new Error(`unexpected fetch ${url}`)
    }
    const body = init?.body
    const params = body instanceof URLSearchParams ? body : new URLSearchParams(typeof body === "string" ? body : "")
    const call = { url, body: params }
    calls.push(call)
    const pending = url === GOOGLE_TOKEN_URL ? await db.select().from(schema.GatewayProviderOauthStateTable) : []
    const { googleOAuthNonce, readGoogleOAuthAttempt } = await import("../src/llm/inference-provider-google-oauth.js")
    const state = pending.find((row) => readGoogleOAuthAttempt(row.code_verifier)?.verifier === params.get("code_verifier"))
    const response = await handler(call)
    if (url !== GOOGLE_TOKEN_URL || !response.ok) return response
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !state) throw new Error("Fixture token exchange missing state")
    return Response.json({ token_type: "Bearer", ...payload, scope: payload.scope ?? GOOGLE_SCOPES, id_token: payload.id_token ?? await googleIdToken({ aud: params.get("client_id") ?? "", nonce: googleOAuthNonce(params.get("code_verifier") ?? "", state.state) }) })
  }
  globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect })
  return run(calls).finally(() => {
    globalThis.fetch = realFetch
  })
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const ownerSessionToken = `ipo-owner-${ownerSessionId}`
const memberSessionToken = `ipo-member-${memberSessionId}`
let ownerCookie = ""
let memberCookie = ""
let inferenceProviderId = ""
let credentialSetId = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))
  mock.module("../src/llm/models-dev.js", () => ({
    getModelsDevProvider: async (providerId: string) => providerId === "google-vertex" ? vertexCatalog : providerId === "google-vertex-anthropic" ? { ...vertexCatalog, id: providerId, npm: "@ai-sdk/google-vertex/anthropic", config: { id: providerId, npm: "@ai-sdk/google-vertex/anthropic" }, models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4", config: { id: "claude-sonnet-4" } }] } : null,
    listModelsDevProviders: async () => [],
    getModelsDevProviders: async (providerIds: readonly string[]) => providerIds.includes(vertexCatalog.id) ? [vertexCatalog] : [],
  }))

  const [appModule, dbModule, schemaModule, drizzleModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "OAuth Owner", email: `oauth-owner+${ownerUserId}@test.local`, emailVerified: true },
    { id: memberUserId, name: "OAuth Member", email: `oauth-member+${memberUserId}@test.local`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Inference OAuth",
    slug: `inference-oauth-${organizationId}`,
    allowedEmailDomains: ["example.test"],
  })
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
  ])
  await db.insert(schema.AuthSessionTable).values([
    { id: ownerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: ownerSessionToken, expiresAt: new Date(Date.now() + 300_000) },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberSessionToken, expiresAt: new Date(Date.now() + 300_000) },
  ])

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  ownerCookie = await serializeSignedCookie("better-auth.session_token", ownerSessionToken, secret)
  memberCookie = await serializeSignedCookie("better-auth.session_token", memberSessionToken, secret)

  const createResponse = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Member Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      settings: { project: "test-project", location: "us-central1" },
      credentialMode: "member",
      oauthClientId: OAUTH_CLIENT_ID,
      oauthClientSecret: OAUTH_CLIENT_SECRET,
      allMembers: true,
    }),
  })
  expect(createResponse.status).toBe(201)
  const provider = readProvider(await createResponse.json())
  inferenceProviderId = readString(provider, "id")
  credentialSetId = readString(defaultSet(provider), "id")
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }
  const inferenceProviderIds = db
    .select({ id: schema.GatewayProviderTable.id })
    .from(schema.GatewayProviderTable)
    .where(drizzle.eq(schema.GatewayProviderTable.organization_id, organizationId))
  const groups = db.select({ id: schema.GatewayModelGroupTable.id }).from(schema.GatewayModelGroupTable).where(drizzle.inArray(schema.GatewayModelGroupTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayModelGroupModelTable).where(drizzle.inArray(schema.GatewayModelGroupModelTable.model_group_id, groups))
  await db.delete(schema.GatewayProviderOauthStateTable).where(drizzle.inArray(schema.GatewayProviderOauthStateTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderAccessTable).where(drizzle.inArray(schema.GatewayProviderAccessTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderModelTable).where(drizzle.inArray(schema.GatewayProviderModelTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.organization_id, organizationId))
  await db.delete(schema.GatewayModelGroupTable).where(drizzle.inArray(schema.GatewayModelGroupTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayCredentialSetTable).where(drizzle.inArray(schema.GatewayCredentialSetTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.organization_id, organizationId))
  await db.delete(schema.GatewayKeyTable).where(drizzle.eq(schema.GatewayKeyTable.organization_id, organizationId))
  await db.delete(schema.InferenceKeyTable).where(drizzle.eq(schema.InferenceKeyTable.organization_id, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, memberSessionId]))
  await db.delete(schema.AuthApiKeyTable).where(drizzle.inArray(schema.AuthApiKeyTable.referenceId, [ownerUserId, memberUserId]))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberUserId]))
  mock.restore()
})

function loadState(state: string) {
  return db
    .select()
    .from(schema.GatewayProviderOauthStateTable)
    .where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
    .then((rows) => rows[0] ?? null)
}

function loadMemberCredential() {
  return db
    .select()
    .from(schema.GatewayProviderCredentialTable)
    .where(drizzle.and(
      drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, credentialSetId),
      drizzle.eq(schema.GatewayProviderCredentialTable.subject, memberId),
    ))
    .then((rows) => rows[0] ?? null)
}

test("member set configuration is explicit and flat writes cannot replace it", async () => {
  const missingClient = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "No Client",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      settings: { project: "test-project", location: "us-central1" },
      credentialMode: "member",
      oauthClientId: OAUTH_CLIENT_ID,
    }),
  })
  expect(missingClient.status).toBe(400)
  expect(await missingClient.json()).toMatchObject({ error: "oauth_client_required" })

  // Org mode never needs the client; flipping to member mode later validates the stored row.
  const orgMode = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Org Vertex", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "test-project", location: "us-central1" }, credential: { kind: "api_key", secret: "fake-org-vertex-key" }, allMembers: true }),
  })
  expect(orgMode.status).toBe(201)
  const orgProvider = readProvider(await orgMode.json())
  expect(defaultSet(orgProvider)).toMatchObject({ oauthClientId: null, hasOauthClientSecret: false })
  const orgProviderId = readString(orgProvider, "id")
  const setId = readString(defaultSet(orgProvider), "id")

  // Org-mode providers have no member sign-in.
  const orgStart = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(orgStart.status).toBe(403)

  const flip = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "member" }),
  })
  expect(flip.status).toBe(409)
  await expect(flip.json()).resolves.toMatchObject({ error: "matrix_write_required" })
  const flipWithClient = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}/credential-sets/${setId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET }),
  })
  expect(flipWithClient.status).toBe(200)
  expect(await flipWithClient.json()).toMatchObject({ credentialSet: { credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, hasOauthClientSecret: true } })
  const memberStart = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(memberStart.status).toBe(302)

  // Switching back requires a new shared credential, never a member's token.
  const missingCredential = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}/credential-sets/${setId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "org", oauthClientSecret: "" }),
  })
  expect(missingCredential.status).toBe(400)
  expect(await missingCredential.json()).toMatchObject({ error: "credential_required" })
  const backToOrg = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}/credential-sets/${setId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "org", oauthClientSecret: "", credential: { kind: "api_key", secret: "fake-replacement-org-vertex-key" } }),
  })
  expect(backToOrg.status).toBe(200)
  expect(await backToOrg.json()).toMatchObject({ credentialSet: { credentialMode: "org", oauthClientId: OAUTH_CLIENT_ID, hasOauthClientSecret: false } })
  const orgStartAfter = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(orgStartAfter.status).toBe(403)
})

test("batch offboarding waits for every OAuth state before locking credentials, like provider deletion", async () => {
  const { revokeInferenceCredentialsForMembers } = await import("../src/llm/inference-provider-lifecycle.js")
  const start = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  expect(start.status).toBe(302)
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
  // Ensure a credential exists for the first member even if the happy-path test has not run yet.
  const credentialId = createDenTypeId("inferenceProviderCredential")
  await db.insert(schema.GatewayProviderCredentialTable).values({
    id: credentialId, gateway_provider_id: inferenceProviderId, credential_set_id: credentialSetId, organization_id: organizationId,
    subject: memberId, org_membership_id: memberId, kind: "oauth_google", secret: JSON.stringify({ accessToken: "fake-lock-order" }), status: "active",
  }).onDuplicateKeyUpdate({ set: { status: "active" } })
  let revocation: Promise<unknown> | undefined
  try {
    await db.transaction(async (tx) => {
      await tx.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId)).for("update")
      await tx.select().from(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state)).for("update")
      revocation = db.transaction(async (other) => {
        await other.select().from(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.id, [memberId, ownerMemberId])).orderBy(schema.MemberTable.id).for("update")
        return revokeInferenceCredentialsForMembers(other, [memberId, ownerMemberId])
      })
      void revocation.catch(() => {})
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await db.execute(drizzle.sql`SELECT 1 FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'gateway_provider_oauth_states' LIMIT 1`)
        waiting = Array.isArray(rows) && rows.length > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(true)
      // Before the fix, offboarding held this credential while waiting for our state lock.
      await tx.select().from(schema.GatewayProviderCredentialTable).where(drizzle.and(
        drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, credentialSetId),
        drizzle.eq(schema.GatewayProviderCredentialTable.subject, memberId),
      )).for("update", { noWait: true })
    })
  } finally {
    if (revocation) await revocation
  }
  expect(await loadState(state)).toBeNull()
  expect((await loadMemberCredential())?.status).toBe("revoked")
})

test("browser-start continues the entry with Google PKCE, OIDC and offline consent; JSON returns authUrl", async () => {
  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  expect(startResponse.status).toBe(302)
  const location = startResponse.headers.get("location")
  if (!location) throw new Error("missing location")
  const authorize = new URL(location)
  expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
  expect(authorize.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID)
  expect(authorize.searchParams.get("response_type")).toBe("code")
  expect(authorize.searchParams.get("scope")).toBe(GOOGLE_SCOPES)
  expect(authorize.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(authorize.searchParams.get("access_type")).toBe("offline")
  expect(authorize.searchParams.get("prompt")).toBe("consent select_account")
  expect(authorize.searchParams.get("include_granted_scopes")).toBe("true")
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
  expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(authorize.searchParams.get("hd")).toBeNull()
  const redirectUri = authorize.searchParams.get("redirect_uri")
  expect(redirectUri).toMatch(/^https?:\/\/.+\/v1\/inference-providers\/oauth\/callback$/)
  expect(location).not.toContain(OAUTH_CLIENT_SECRET)

  const state = authorize.searchParams.get("state")
  if (!state) throw new Error("missing state")
  const stateRow = await loadState(state)
  if (!stateRow) throw new Error("state row missing")
  expect(stateRow).toMatchObject({ gateway_provider_id: inferenceProviderId, credential_set_id: credentialSetId, org_membership_id: memberId, redirect_to: null, used_at: null })
  expect(stateRow.expires_at.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000)
  const { readGoogleOAuthAttempt, googleOAuthNonce } = await import("../src/llm/inference-provider-google-oauth.js")
  const attempt = readGoogleOAuthAttempt(stateRow.code_verifier)
  expect(attempt?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(attempt?.userId).toBe(memberUserId)
  expect(authorize.searchParams.get("nonce")).toBe(googleOAuthNonce(attempt?.verifier ?? "", state))
  // The verifier is stored encrypted at rest.
  const [raw] = await db.execute(drizzle.sql`select code_verifier from gateway_provider_oauth_states where state = ${state}`)
  expect(JSON.stringify(raw)).not.toContain(stateRow.code_verifier)

  const jsonResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`, {
    headers: { accept: "application/json" },
  })
  expect(jsonResponse.status).toBe(200)
  const payload: unknown = await jsonResponse.json()
  if (!isRecord(payload)) throw new Error("expected object")
  const authUrl = new URL(readString(payload, "authUrl"))
  expect(authUrl.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID)
  const jsonState = authUrl.searchParams.get("state")
  if (!jsonState) throw new Error("missing state")
  expect(jsonState).not.toBe(state)
  expect((await loadState(jsonState))?.redirect_to).toBe("openwork://inference/connected")

  const badRedirect = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("https://evil.example/steal")}`)
  expect(badRedirect.status).toBe(400)
  await expect(badRedirect.json()).resolves.toMatchObject({ error: "invalid_redirect" })

  const trustedRedirect = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent(`${API_ORIGIN}/settings`)}`)
  expect(trustedRedirect.status).toBe(302)
})

test("callback exchanges the code, stores the encrypted member token, marks the state used, and flips connect to ready", async () => {
  const before = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(before).toMatchObject({ credentialStatus: "member_auth_required", models: [] })
  const pending = readRows(before, "authorizationRequests")
  expect(pending).toHaveLength(1)
  const pendingModels = readRows(pending[0], "models")
  expect(pendingModels).toHaveLength(1)
  expect(pendingModels[0]).toMatchObject({ upstreamModelId: "gemini-2.5-pro", credentialSetId, config: { id: pendingModels[0].id } })
  expect(readString(pendingModels[0], "id")).toMatch(/^gwm_/)
  expect(new URL(readString(before, "authUrl")).searchParams.get("credentialSetId")).toBe(credentialSetId)

  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  const authorize = new URL(startResponse.headers.get("location") ?? "")
  const state = authorize.searchParams.get("state") ?? ""
  const codeChallenge = authorize.searchParams.get("code_challenge")
  const redirectUri = authorize.searchParams.get("redirect_uri")

  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.access", refresh_token: "1//refresh", token_type: "Bearer", expires_in: 3600, scope: GOOGLE_SCOPES }),
    async (calls) => {
      const callback = await browserRequest(`/v1/inference-providers/oauth/callback?code=4/auth-code&state=${encodeURIComponent(state)}`)
      expect(callback.status).toBe(200)
      const html = await callback.text()
      expect(html).toContain("You're connected")
      expect(html).not.toContain("ya29.access")

      expect(calls).toHaveLength(1)
      const exchange = calls[0]
      if (!exchange) throw new Error("no token exchange")
      expect(exchange.url).toBe(GOOGLE_TOKEN_URL)
      expect(exchange.body.get("grant_type")).toBe("authorization_code")
      expect(exchange.body.get("code")).toBe("4/auth-code")
      expect(exchange.body.get("client_id")).toBe(OAUTH_CLIENT_ID)
      expect(exchange.body.get("client_secret")).toBe(OAUTH_CLIENT_SECRET)
      expect(exchange.body.get("redirect_uri")).toBe(redirectUri)
      const verifier = exchange.body.get("code_verifier") ?? ""
      const { createHash } = await import("node:crypto")
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(codeChallenge)
    },
  )

  const stateRow = await loadState(state)
  expect(stateRow?.used_at).not.toBeNull()

  const credential = await loadMemberCredential()
  if (!credential) throw new Error("credential missing")
  expect(credential).toMatchObject({
    org_membership_id: memberId,
    kind: "oauth_google",
    status: "active",
    scopes: GOOGLE_SCOPES,
  })
  expect(JSON.parse(credential.secret)).toEqual({ accessToken: "ya29.access", refreshToken: "1//refresh", tokenType: "Bearer", googleIdentity: { subject: "fixture-google-subject", email: "google-account@example.test", emailVerified: true, clientId: OAUTH_CLIENT_ID, authorizationRevision: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } })
  expect(credential.secret).not.toContain("id_token")
  const expiresIn = (credential.expires_at?.getTime() ?? 0) - Date.now()
  expect(expiresIn).toBeGreaterThan(3500 * 1000)
  expect(expiresIn).toBeLessThanOrEqual(3600 * 1000)
  const [rawCredential] = await db.execute(drizzle.sql`select secret from gateway_provider_credentials where id = ${credential.id}`)
  expect(JSON.stringify(rawCredential)).not.toContain("ya29.access")

  const after = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(after).toMatchObject({ credentialStatus: "ready", authUrl: null, authorizationRequests: [], models: pendingModels })
  expect(after.apiKey).toBe(before.apiKey)
  expect(after.apiKeys).toEqual(before.apiKeys)
  for (const secret of ["ya29.access", "1//refresh", OAUTH_CLIENT_SECRET]) expect(JSON.stringify(after)).not.toContain(secret)
  // Only the member who consented is ready; the owner still needs to sign in.
  const ownerConnect = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(ownerConnect).toMatchObject({ credentialStatus: "member_auth_required", models: [], authorizationRequests: [{ credentialSetId, models: pendingModels }] })

  // Replaying the same state never reaches Google.
  await withFakeGoogle(
    () => { throw new Error("must not exchange") },
    async (calls) => {
      const replay = await browserRequest(`/v1/inference-providers/oauth/callback?code=4/again&state=${encodeURIComponent(state)}`)
      expect(replay.status).toBe(400)
      expect(await replay.text()).toContain("already used")
      expect(calls).toHaveLength(0)
    },
  )
})

for (const failure of ["wrong_nonce", "wrong_verifier", "invalid_signature"]) {
  test.each(["succeeded", "rejected", "unavailable"])(`callback cleans up issued tokens after ${failure} with revocation=%s without replacing the stored DB credential (not proof of Google grant validity)`, async (revocation) => {
    const existing = await loadMemberCredential()
    expect(existing?.status).toBe("active")
    const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
    expect(start.status).toBe(302)
    const authorize = new URL(start.headers.get("location") ?? "")
    const state = authorize.searchParams.get("state") ?? ""
    const { googleOAuthNonce, readGoogleOAuthAttempt } = await import("../src/llm/inference-provider-google-oauth.js")
    const attempt = readGoogleOAuthAttempt((await loadState(state))?.code_verifier ?? "")
    expect(attempt).not.toBeNull()
    const nonce = failure === "wrong_nonce" ? "fixture-wrong-nonce"
      : failure === "wrong_verifier" ? googleOAuthNonce("fixture-other-verifier", state)
      : authorize.searchParams.get("nonce")
    const idToken = failure === "invalid_signature"
      ? await new SignJWT({ iss: "https://accounts.google.com", aud: OAUTH_CLIENT_ID, sub: "fixture-subject", email: "fixture@example.test", email_verified: true, nonce })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-google" }).setIssuedAt().setExpirationTime("1h").sign((await generateKeyPair("RS256")).privateKey)
      : await googleIdToken({ nonce })
    await withFakeGoogle((call) => {
      if (call.url === GOOGLE_REVOKE_URL) {
        expect(call.body.get("token")).toBe("fixture-unverified-refresh")
        if (revocation === "unavailable") throw new Error("FIXTURE_REVOCATION_PRIVATE_DETAIL")
        return new Response(null, { status: revocation === "rejected" ? 503 : 200 })
      }
      expect(call.body.get("code_verifier")).toBe(attempt?.verifier)
      return Response.json({ access_token: "fixture-unverified-access", refresh_token: "fixture-unverified-refresh", expires_in: 3600, id_token: idToken })
    }, async (calls) => {
      const callback = await browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${encodeURIComponent(state)}`)
      expect(callback.status).toBe(400)
      const html = await callback.text()
      expect(html).toContain("Google account verification failed")
      expect(html).toContain("Cleanup revocation may affect existing Google connections")
      expect(html).toContain("including your previous connection")
      expect(html).toContain("You may need to reconnect those connections")
      for (const privateValue of ["fixture-unverified-access", "fixture-unverified-refresh", idToken, "FIXTURE_REVOCATION_PRIVATE_DETAIL"]) expect(html).not.toContain(privateValue)
      expect(calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL])
      expect(calls[1]?.body.get("token")).toBe("fixture-unverified-refresh")
      expect(await loadMemberCredential()).toEqual(existing)
      expect((await loadState(state))?.used_at).not.toBeNull()
      const replay = await browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${encodeURIComponent(state)}`)
      expect(replay.status).toBe(400)
      expect(calls).toHaveLength(2)
    })
  })
}

test.each([
  { expires_in: 0, refresh_token: "fixture-unvalidated-refresh" },
  { expires_in: 3600, refresh_token: "fixture-invalid\r\nrefresh" },
  { expires_in: 3600, refresh_token: "fixture-unvalidated-refresh", scope: "openid email" },
])("callback does not take cleanup ownership of an unvalidated token response: %j", async (fields) => {
  const existing = await loadMemberCredential()
  const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  expect(start.status).toBe(302)
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await withFakeGoogle(() => Response.json({ access_token: "fixture-unvalidated-access", ...fields }), async (calls) => {
    const callback = await browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${encodeURIComponent(state)}`)
    expect(callback.status).toBe(400)
    expect(calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL])
    expect(await loadMemberCredential()).toEqual(existing)
    expect((await loadState(state))?.used_at).not.toBeNull()
  })
})

test("callback rejects expired and unknown state, and redirects failures with error= when redirectTo was given", async () => {
  const unknown = await browserRequest("/v1/inference-providers/oauth/callback?code=x&state=not-a-state")
  expect(unknown.status).toBe(400)
  expect(await unknown.text()).toContain("expired or was already used")

  const missing = await browserRequest("/v1/inference-providers/oauth/callback?code=x")
  expect(missing.status).toBe(400)

  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected?provider=1")}`)
  const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await db
    .update(schema.GatewayProviderOauthStateTable)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
  const expired = await browserRequest(`/v1/inference-providers/oauth/callback?code=x&state=${encodeURIComponent(state)}`)
  expect(expired.status).toBe(400)
  expect((await loadState(state))?.used_at).toBeNull()

  const deniedStart = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected?provider=1")}`)
  const deniedState = new URL(deniedStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const denied = await browserRequest(`/v1/inference-providers/oauth/callback?error=access_denied&state=${encodeURIComponent(deniedState)}`)
  expect(denied.status).toBe(302)
  const deniedLocation = new URL(denied.headers.get("location") ?? "")
  expect(`${deniedLocation.protocol}//${deniedLocation.host}${deniedLocation.pathname}`).toBe("openwork://inference/connected")
  expect(deniedLocation.searchParams.get("provider")).toBe("1")
  expect(deniedLocation.searchParams.get("error")).toBe("Google access was denied.")
  expect((await loadState(deniedState))?.used_at).not.toBeNull()

  const failedStart = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`)
  const failedState = new URL(failedStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await withFakeGoogle(
    () => Response.json({ error: "invalid_grant", error_description: "Bad code FAKE_TOKEN_MUST_NOT_ECHO" }, { status: 400 }),
    async () => {
      const failed = await browserRequest(`/v1/inference-providers/oauth/callback?code=bad&state=${encodeURIComponent(failedState)}`)
      expect(failed.status).toBe(302)
      const location = new URL(failed.headers.get("location") ?? "")
      expect(location.searchParams.get("error")).toContain("Google could not complete authorization")
      expect(location.toString()).not.toContain("FAKE_TOKEN_MUST_NOT_ECHO")
    },
  )

  const credentialBeforeMissingRefresh = await loadMemberCredential()
  const successStart = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`)
  const successState = new URL(successStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.second", expires_in: 3600 }),
    async () => {
      const success = await browserRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${encodeURIComponent(successState)}`)
      expect(success.status).toBe(302)
      expect(new URL(success.headers.get("location") ?? "").searchParams.get("error")).toContain("offline access")
    },
  )
  expect(await loadMemberCredential()).toEqual(credentialBeforeMissingRefresh)
})

test.each([true, false])("DELETE oauth revokes the refresh token at Google with deployment management enabled=%s", async (enabled) => {
  const { env } = await import("../src/env.js")
  const previous = env.gatewayEnabled
  env.gatewayEnabled = enabled
  try {
    await withFakeGoogle(
      () => Response.json({ access_token: "ya29.third", refresh_token: "1//refresh-third", expires_in: 3600 }),
      async () => {
        const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
        const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
        const callback = await browserRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${encodeURIComponent(state)}`)
        expect(callback.status).toBe(200)
      },
    )

    const ownerDelete = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/oauth`, { method: "DELETE" })
    expect(ownerDelete.status).toBe(204)

    await withFakeGoogle(
      () => new Response(null, { status: 200 }),
      async (calls) => {
        const revoked = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth`, { method: "DELETE" })
        expect(revoked.status).toBe(204)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe(GOOGLE_REVOKE_URL)
        expect(calls[0]?.body.get("token")).toBe("1//refresh-third")
      },
    )
    const credential = await loadMemberCredential()
    expect(credential?.status).toBe("revoked")

    const connect = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
    expect(connect).toMatchObject({ credentialStatus: "member_auth_required" })
    expect(readString(connect, "authUrl")).toContain("/oauth/start")

    const again = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth`, { method: "DELETE" })
    expect(again.status).toBe(204)
  } finally {
    env.gatewayEnabled = previous
  }
})

test("named member sets coexist with ready models and fence in-flight consent independently", async () => {
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Scoped OAuth", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "test-project", location: "us-central1" }, credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET, memberIds: [memberId] }) })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const firstSetId = readString(defaultSet(provider), "id")
  if (!Array.isArray(provider.modelGroups) || !isRecord(provider.modelGroups[0])) throw new Error("modelGroups missing")
  const groupId = readString(provider.modelGroups[0], "id")
  const base = `/v1/inference-providers/${id}`
  const second = await request(ownerCookie, `${base}/credential-sets`, { method: "POST", body: JSON.stringify({ name: "Second member client", credentialMode: "member", oauthClientId: "second-client.apps.googleusercontent.com", oauthClientSecret: "fake-second-client-secret" }) })
  expect(second.status).toBe(201)
  const secondBody: unknown = await second.json()
  if (!isRecord(secondBody) || !isRecord(secondBody.credentialSet)) throw new Error("credentialSet missing")
  const secondSetId = readString(secondBody.credentialSet, "id")
  const grant = await request(ownerCookie, `${base}/access-grants`, { method: "POST", body: JSON.stringify({ modelGroupId: groupId, credentialSetId: secondSetId, audience: { type: "organization" } }) })
  expect(grant.status).toBe(201)
  const grantBody: unknown = await grant.json()
  if (!isRecord(grantBody) || !isRecord(grantBody.accessGrant)) throw new Error("accessGrant missing")
  const secondGrantId = readString(grantBody.accessGrant, "id")
  const beforeConsent = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  expect(beforeConsent.models).toEqual([])
  const pendingSets = readRows(beforeConsent, "authorizationRequests")
  expect(pendingSets).toHaveLength(2)
  const firstPendingSet = pendingSets.find((row) => row.credentialSetId === firstSetId)
  const secondPendingSet = pendingSets.find((row) => row.credentialSetId === secondSetId)
  if (!firstPendingSet || !secondPendingSet) throw new Error("Pending sets missing")
  const firstModels = readRows(firstPendingSet, "models")
  const secondModels = readRows(secondPendingSet, "models")
  expect(firstModels).toHaveLength(1)
  expect(secondModels).toHaveLength(1)
  expect(firstModels[0].id).not.toBe(secondModels[0].id)
  expect((await request(memberCookie, `${base}/oauth/start`)).status).toBe(409)
  expect((await request(memberCookie, `${base}/oauth/start?credentialSetId=${credentialSetId}`)).status).toBe(403)
  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.first-set", refresh_token: "first-set-refresh", expires_in: 3600 }),
    async () => {
      const start = await request(memberCookie, `${base}/oauth/start?credentialSetId=${firstSetId}`, { headers: { accept: "application/json" } })
      expect(start.status).toBe(200)
      const body: unknown = await start.json()
      if (!isRecord(body)) throw new Error("authUrl missing")
      const url = new URL(readString(body, "authUrl"))
      expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID)
      const state = url.searchParams.get("state") ?? ""
      expect((await loadState(state))?.credential_set_id).toBe(firstSetId)
      expect((await browserRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${state}`)).status).toBe(200)
    },
  )
  const mixed = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  expect(mixed).toMatchObject({ credentialStatus: "ready", models: firstModels, authorizationRequests: [{ credentialSetId: secondSetId, models: secondModels }] })
  expect(readRows(mixed, "authorizationRequests")).toEqual([secondPendingSet])
  expect(readString(mixed, "apiKey")).toMatch(/^ow_gw_/)
  const firstCredential = await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.and(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, firstSetId), drizzle.eq(schema.GatewayProviderCredentialTable.subject, memberId)))
  const pending = await request(memberCookie, `${base}/oauth/start?credentialSetId=${secondSetId}`)
  const pendingUrl = new URL(pending.headers.get("location") ?? "")
  expect(pendingUrl.searchParams.get("client_id")).toBe("second-client.apps.googleusercontent.com")
  const pendingState = pendingUrl.searchParams.get("state") ?? ""
  const pendingSnapshot = await loadState(pendingState)
  expect(pendingSnapshot).not.toBeNull()
  expect((await request(ownerCookie, `${base}/model-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed group", description: "Metadata only" }) })).status).toBe(200)
  expect((await request(ownerCookie, `${base}/credential-sets/${secondSetId}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed member client" }) })).status).toBe(200)
  expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ settings: { project: "test-project", location: "us-central1" } }) })).status).toBe(200)
  const otherGroup = await request(ownerCookie, `${base}/model-groups`, { method: "POST", body: JSON.stringify({ name: "Unrelated group", modelIds: ["gemini-2.5-pro"] }) })
  expect(otherGroup.status).toBe(201)
  const otherGroupBody: unknown = await otherGroup.json()
  if (!isRecord(otherGroupBody) || !isRecord(otherGroupBody.modelGroup)) throw new Error("modelGroup missing")
  const otherGroupId = readString(otherGroupBody.modelGroup, "id")
  const otherGrant = await request(ownerCookie, `${base}/access-grants`, { method: "POST", body: JSON.stringify({ modelGroupId: otherGroupId, credentialSetId: firstSetId, audience: { type: "organization" } }) })
  expect(otherGrant.status).toBe(201)
  const otherGrantBody: unknown = await otherGrant.json()
  if (!isRecord(otherGrantBody) || !isRecord(otherGrantBody.accessGrant)) throw new Error("accessGrant missing")
  const otherGrantId = readString(otherGrantBody.accessGrant, "id")
  expect((await request(ownerCookie, `${base}/model-groups/${otherGroupId}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) })).status).toBe(200)
  expect((await request(ownerCookie, `${base}/access-grants/${otherGrantId}`, { method: "DELETE" })).status).toBe(204)
  expect((await request(ownerCookie, `${base}/model-groups/${otherGroupId}`, { method: "DELETE" })).status).toBe(204)
  expect(await loadState(pendingState)).toEqual(pendingSnapshot)
  const firstPending = await request(memberCookie, `${base}/oauth/start?credentialSetId=${firstSetId}`)
  expect(firstPending.status).toBe(302)
  const firstPendingState = new URL(firstPending.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const firstPendingSnapshot = await loadState(firstPendingState)
  expect(firstPendingSnapshot).not.toBeNull()
  await withFakeGoogle(
    async (call) => {
      if (call.url === GOOGLE_REVOKE_URL) return new Response(null, { status: 200 })
      const changed = await request(ownerCookie, `${base}/credential-sets/${secondSetId}`, { method: "PATCH", body: JSON.stringify({ oauthClientSecret: "fake-rotated-second-client" }) })
      expect(changed.status).toBe(200)
      return Response.json({ access_token: "ya29.stale-second", refresh_token: "stale-second-refresh", expires_in: 3600 })
    },
    async (calls) => {
      const callback = await browserRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${pendingState}`)
      expect(callback.status).toBe(400)
      expect(calls.some((call) => call.url === GOOGLE_REVOKE_URL && call.body.get("token") === "stale-second-refresh")).toBe(true)
    },
  )
  expect(await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.and(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, firstSetId), drizzle.eq(schema.GatewayProviderCredentialTable.subject, memberId)))).toEqual(firstCredential)
  expect(await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, secondSetId))).toEqual([])
  expect(await loadState(firstPendingState)).toEqual(firstPendingSnapshot)
  expect(await loadState(pendingState)).toBeNull()
  const lostAccessStart = await request(memberCookie, `${base}/oauth/start?credentialSetId=${secondSetId}`)
  expect(lostAccessStart.status).toBe(302)
  const lostAccessState = new URL(lostAccessStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  expect((await request(ownerCookie, `${base}/access-grants/${secondGrantId}`, { method: "DELETE" })).status).toBe(204)
  expect(await loadState(lostAccessState)).not.toBeNull()
  await withFakeGoogle(
    () => { throw new Error("Lost authorization must never exchange tokens") },
    async (calls) => {
      expect((await browserRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${lostAccessState}`)).status).toBe(400)
      expect(calls).toHaveLength(0)
    },
  )
  expect((await request(memberCookie, `${base}/oauth?credentialSetId=${secondSetId}`, { method: "DELETE" })).status).toBe(204)
  expect(readProvider(await (await request(memberCookie, `${base}/connect`)).json()).models).toMatchObject([{ credentialSetId: firstSetId }])
})

test("personal OAuth requires a current same-org member grant, never permits shared-key administration or another member's credential", async () => {
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Personal OAuth boundary", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "test-project", location: "us-central1" }, credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET, memberIds: [memberId, ownerMemberId] }) })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const setId = readString(defaultSet(provider), "id")
  const base = `/v1/inference-providers/${id}`
  if (!Array.isArray(provider.accessGrants)) throw new Error("accessGrants missing")
  const memberGrant = provider.accessGrants.find((entry: unknown) => isRecord(entry) && isRecord(entry.audience) && entry.audience.memberId === memberId)
  if (!isRecord(memberGrant)) throw new Error("Member grant missing")
  const start = async (cookie: string) => {
    const response = await request(cookie, `${base}/oauth/start?credentialSetId=${setId}`)
    expect(response.status).toBe(302)
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state")
    if (!state) throw new Error("OAuth state missing")
    return state
  }
  const credentials = () => db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, id))
  const callback = (state: string, cookie = memberCookie) => browserRequest(`/v1/inference-providers/oauth/callback?code=fake-code&state=${encodeURIComponent(state)}`, cookie)
  // Ordinary self-service must not inherit the fresh-auth requirement for administration.
  await db.update(schema.AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
  try {
    await withFakeGoogle(
      () => Response.json({ access_token: "fake-personal-access", refresh_token: "fake-personal-refresh", expires_in: 3600 }),
      async () => {
        expect((await callback(await start(ownerCookie), ownerCookie)).status).toBe(200)
        expect((await callback(await start(memberCookie))).status).toBe(200)
      },
    )
    const before = await credentials()
    expect(before).toHaveLength(2)
    const otherCredential = before.find((row) => row.org_membership_id === ownerMemberId)
    if (!otherCredential) throw new Error("Other member credential missing")
    const connect = await request(memberCookie, `${base}/connect`)
    expect(connect.status).toBe(200)
    const connectedText = await connect.text()
    expect(connectedText).not.toContain(ownerMemberId)
    expect(connectedText).not.toContain(otherCredential.id)
    expect(connectedText).not.toContain("fake-personal")
    const connected = readProvider(JSON.parse(connectedText))
    expect(connected.credentialStatus).toBe("ready")
    expect(connected.credentials).toBeUndefined()
    expect(connected.credentialSets).toBeUndefined()
    expect(connected.accessGrants).toBeUndefined()
    const listed = await request(memberCookie, "/v1/inference-providers?scope=usable")
    expect(listed.status).toBe(200)
    const listedText = await listed.text()
    expect(listedText).not.toContain(otherCredential.id)
    expect(listedText).not.toContain("fake-personal")
    for (const body of [
      { credentialMode: "org", credential: { kind: "api_key", secret: "fake-claimed-shared-key" } },
      { oauthClientId: "fake-replacement-client", oauthClientSecret: "fake-replacement-secret" },
    ]) expect((await request(memberCookie, `${base}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify(body) })).status).toBe(403)
    expect((await request(memberCookie, `${base}/oauth?credentialSetId=${setId}&orgMembershipId=${ownerMemberId}`, { method: "DELETE" })).status).toBe(400)
    expect(await credentials()).toEqual(before)
    await withFakeGoogle(() => new Response(null, { status: 200 }), async (calls) => {
      expect((await request(memberCookie, `${base}/oauth?credentialSetId=${setId}`, { method: "DELETE" })).status).toBe(204)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(GOOGLE_REVOKE_URL)
    })
    expect((await credentials()).find((row) => row.org_membership_id === ownerMemberId)).toEqual(otherCredential)
    expect((await credentials()).find((row) => row.org_membership_id === memberId)?.status).toBe("revoked")

    const foreignOrg = createDenTypeId("organization")
    const foreignMember = createDenTypeId("member")
    await db.insert(schema.OrganizationTable).values({ id: foreignOrg, name: "Foreign OAuth boundary", slug: foreignOrg })
    await db.insert(schema.MemberTable).values({ id: foreignMember, organizationId: foreignOrg, userId: memberUserId, role: "owner" })
    try {
      const state = await start(memberCookie)
      await db.update(schema.GatewayProviderOauthStateTable).set({ org_membership_id: foreignMember }).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
      await withFakeGoogle(() => { throw new Error("Cross-org state must not exchange credentials") }, async (calls) => {
        expect((await callback(state)).status).toBe(400)
        expect(calls).toHaveLength(0)
      })
      await db.delete(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
    } finally {
      await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, foreignMember))
      await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, foreignOrg))
    }

    const pending = await start(memberCookie)
    expect((await request(ownerCookie, `${base}/access-grants/${readString(memberGrant, "id")}`, { method: "DELETE" })).status).toBe(204)
    const afterRevocation = await credentials()
    await withFakeGoogle(() => { throw new Error("Revoked grants must not exchange or revoke credentials") }, async (calls) => {
      expect((await callback(pending)).status).toBe(400)
      expect((await request(memberCookie, `${base}/oauth/start?credentialSetId=${setId}`)).status).toBe(403)
      expect((await request(memberCookie, `${base}/oauth?credentialSetId=${setId}`, { method: "DELETE" })).status).toBe(204)
      expect(calls).toHaveLength(0)
    })
    expect((await request(memberCookie, `${base}/connect`)).status).toBe(403)
    expect(await (await request(memberCookie, "/v1/inference-providers?scope=usable")).text()).not.toContain(id)
    expect((await credentials()).filter((row) => row.org_membership_id !== memberId)).toEqual(afterRevocation.filter((row) => row.org_membership_id !== memberId))
    expect((await credentials()).find((row) => row.org_membership_id === memberId)).toMatchObject({ status: "revoked", secret: "{}" })
    expect((await request(ownerCookie, `${base}/connect`)).status).toBe(200)
  } finally {
    await db.update(schema.AuthSessionTable).set({ createdAt: new Date() }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
  }
})

test.each(["browser", "desktop"])("OAuth callback binds %s initiation to the independent browser user before consuming state or redirecting", async (mode) => {
  const { auth } = await import("../src/auth.js")
  const { buildOrganizationApiKeyMetadata } = await import("../src/api-keys.js")
  const { createInternalMcpPrincipalHeader } = await import("../src/session.js")
  const apiKey = await auth.api.createApiKey({ body: {
    userId: memberUserId, name: "OAuth boundary fixture", rateLimitEnabled: false,
    metadata: buildOrganizationApiKeyMetadata({ organizationId, orgMembershipId: memberId, issuedByUserId: memberUserId, issuedByOrgMembershipId: memberId }),
  } })
  const browserSessionId = createDenTypeId("session")
  const browserToken = `ipo-browser-${browserSessionId}`
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  // Desktop and browser do not share a session ID, or necessarily an active org.
  await db.insert(schema.AuthSessionTable).values({ id: browserSessionId, userId: memberUserId, token: browserToken, activeOrganizationId: null, expiresAt: new Date(Date.now() + 300_000) })
  const browserCookie = await serializeSignedCookie("openwork-den.session_token", browserToken, secret)
  const base = `/v1/inference-providers/${inferenceProviderId}`
  const startPath = `${base}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`
  const start = async () => {
    const headers = new Headers({ accept: "application/json" })
    headers.set(mode === "desktop" ? "authorization" : "cookie", mode === "desktop" ? `Bearer ${memberSessionToken}` : memberCookie)
    const response = await publicRequest(startPath, headers)
    expect(response.status).toBe(200)
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error("OAuth start response missing")
    const entry = new URL(readString(payload, "authUrl"))
    expect(entry.pathname).toBe("/gateway/connect")
    expect(entry.href).not.toContain(memberSessionToken)
    const browserStart = await publicRequest(`/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(entry.searchParams.get("attempt") ?? "")}`, { cookie: browserCookie, accept: "application/json" })
    expect(browserStart.status).toBe(200)
    const browserPayload: unknown = await browserStart.json()
    if (!isRecord(browserPayload)) throw new Error("Browser start missing")
    const url = new URL(readString(browserPayload, "authUrl"))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.href).not.toContain(memberSessionToken)
    const state = url.searchParams.get("state")
    if (!state) throw new Error("OAuth state missing")
    return state
  }
  const credentials = () => db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, inferenceProviderId))
  try {
    // API keys and delegated principals are not initiating user sessions either.
    const nonSessionHeaders: HeadersInit[] = [
      { "x-api-key": apiKey.key },
      { "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId: memberUserId, organizationId }) },
    ]
    for (const headers of nonSessionHeaders) {
      const statesBefore = await db.select().from(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.gateway_provider_id, inferenceProviderId))
      expect((await publicRequest(startPath, headers)).status).toBe(403)
      expect((await publicRequest("/v1/inference-providers/member-connections", headers)).status).toBe(403)
      expect(await db.select().from(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.gateway_provider_id, inferenceProviderId))).toEqual(statesBefore)
    }
    for (const outcome of ["code=fake-browser-bound-code", "error=access_denied"]) {
      const state = await start()
      const path = `/v1/inference-providers/oauth/callback?${outcome}&state=${encodeURIComponent(state)}`
      const stateBefore = await loadState(state)
      expect(stateBefore?.used_at).toBeNull()
      const credentialsBefore = await credentials()
      await withFakeGoogle(() => { throw new Error("Unbound callbacks must not contact Google") }, async (calls) => {
        const rejectedHeaders: HeadersInit[] = [
          {},
          { cookie: ownerCookie },
          { authorization: `Bearer ${memberSessionToken}` },
          { cookie: ownerCookie, authorization: `Bearer ${memberSessionToken}` },
          { "x-api-key": apiKey.key },
          { cookie: ownerCookie, "x-api-key": apiKey.key },
          { cookie: `openwork-den.session_token=${memberSessionToken}` },
          { "x-user-id": memberUserId, "x-den-internal-mcp-principal": `${memberUserId}.forged` },
          { "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId: memberUserId, organizationId }) },
        ]
        for (const headers of rejectedHeaders) {
          const response = await publicRequest(path, headers)
          expect(response.status).toBe(400)
          expect(response.headers.get("location")).toBeNull()
          expect(response.headers.get("set-cookie")).toBeNull()
          expect(await response.text()).toContain("Sign in to Den in this browser")
          expect(await loadState(state)).toEqual(stateBefore)
          expect(await credentials()).toEqual(credentialsBefore)
        }
        expect(calls).toHaveLength(0)
      })
      // The failed attempts did not burn the legitimate user's state.
      await withFakeGoogle(() => Response.json({ access_token: "fake-bound-access", refresh_token: "fake-bound-refresh", expires_in: 3600 }), async (calls) => {
        const response = await browserRequest(path, browserCookie)
        expect(response.status).toBe(302)
        expect(response.headers.get("location")).toBe(outcome.startsWith("code=") ? "openwork://inference/connected" : "openwork://inference/connected?error=Google+access+was+denied.")
        expect(calls).toHaveLength(outcome.startsWith("code=") ? 1 : 0)
        expect((await loadState(state))?.used_at).not.toBeNull()
      })
      if (outcome.startsWith("error=")) expect(await credentials()).toEqual(credentialsBefore)
      else {
        const credential = await loadMemberCredential()
        expect(credential?.status).toBe("active")
        expect(JSON.parse(credential?.secret ?? "{}")).toMatchObject({ accessToken: "fake-bound-access", refreshToken: "fake-bound-refresh", tokenType: "Bearer", googleIdentity: { subject: "fixture-google-subject" } })
      }
      expect((await credentials()).filter((row) => row.org_membership_id !== memberId)).toEqual(credentialsBefore.filter((row) => row.org_membership_id !== memberId))
    }
    // Correct-user disconnect still revokes only their credential and pending states.
    const pending = await start()
    const otherCredentials = (await credentials()).filter((row) => row.org_membership_id !== memberId)
    await withFakeGoogle(() => new Response(null, { status: 200 }), async (calls) => {
      expect((await request(memberCookie, `${base}/oauth`, { method: "DELETE" })).status).toBe(204)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(GOOGLE_REVOKE_URL)
      expect(calls[0]?.body.get("token")).toBe("fake-bound-refresh")
    })
    expect(await loadState(pending)).toBeNull()
    expect((await loadMemberCredential())?.status).toBe("revoked")
    const afterDisconnect = await credentials()
    expect(afterDisconnect.filter((row) => row.org_membership_id !== memberId)).toEqual(otherCredentials)
    await withFakeGoogle(() => { throw new Error("Revoked state must not contact Google") }, async (calls) => {
      for (const cookie of ["", ownerCookie, browserCookie]) {
        for (const outcome of ["code=fake-code", "error=access_denied"]) {
          const response = await browserRequest(`/v1/inference-providers/oauth/callback?${outcome}&state=${pending}`, cookie)
          expect(response.status).toBe(400)
          expect(response.headers.get("location")).toBeNull()
        }
      }
      expect(calls).toHaveLength(0)
    })
    expect(await credentials()).toEqual(afterDisconnect)
  } finally {
    await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, browserSessionId))
    await db.delete(schema.AuthApiKeyTable).where(drizzle.eq(schema.AuthApiKeyTable.referenceId, memberUserId))
  }
})

test.each(["expired", "revoked"])("OAuth callback rejects a %s signed browser session without changing state or credentials", async (invalidity) => {
  const sessionId = createDenTypeId("session")
  const token = `ipo-invalid-browser-${sessionId}`
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  await db.insert(schema.AuthSessionTable).values({ id: sessionId, userId: memberUserId, token, expiresAt: new Date(Date.now() + 300_000) })
  const cookie = await serializeSignedCookie("openwork-den.session_token", token, secret)
  try {
    // Resolve the session first so a cached principal cannot mask DB revocation.
    await browserRequest("/v1/inference-providers/oauth/callback?error=access_denied", cookie)
    if (invalidity === "expired") await db.update(schema.AuthSessionTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
    else await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
    const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`)
    expect(start.status).toBe(302)
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const before = await loadState(state)
    expect(before?.used_at).toBeNull()
    const credentialBefore = await loadMemberCredential()
    await withFakeGoogle(() => { throw new Error("Invalid sessions must not contact Google") }, async (calls) => {
      for (const outcome of ["code=fake-code", "error=access_denied"]) {
        const response = await browserRequest(`/v1/inference-providers/oauth/callback?${outcome}&state=${state}`, cookie)
        expect(response.status).toBe(400)
        expect(response.headers.get("location")).toBeNull()
        expect(await response.text()).toContain("Sign in to Den in this browser")
      }
      expect(calls).toHaveLength(0)
    })
    expect(await loadState(state)).toEqual(before)
    expect(await loadMemberCredential()).toEqual(credentialBefore)
    const denied = await browserRequest(`/v1/inference-providers/oauth/callback?error=access_denied&state=${state}`)
    expect(denied.status).toBe(302)
    expect((await loadState(state))?.used_at).not.toBeNull()
    expect(await loadMemberCredential()).toEqual(credentialBefore)
  } finally {
    await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
  }
})

test("default start returns a non-authenticating browser entry and browser-start requires the original live signed user", async () => {
  const path = `/v1/inference-providers/${inferenceProviderId}/oauth/start?credentialSetId=${credentialSetId}&redirectTo=${encodeURIComponent("openwork://inference/connected")}`
  const response = await publicRequest(path, { authorization: `Bearer ${memberSessionToken}`, accept: "application/json" })
  expect(response.status).toBe(200)
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error("Entry missing")
  const entry = new URL(readString(payload, "authUrl"))
  expect(entry.origin).toBe(API_ORIGIN)
  expect(entry.pathname).toBe("/gateway/connect")
  expect([...entry.searchParams.keys()]).toEqual(["attempt"])
  expect(entry.href).not.toContain(memberSessionToken)
  const attempt = entry.searchParams.get("attempt") ?? ""
  const before = await loadState(attempt)
  expect(before?.redirect_to).toBe("openwork://inference/connected")
  const browserPath = `/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`
  for (const headers of [{}, { authorization: `Bearer ${memberSessionToken}` }, { cookie: `better-auth.session_token=${memberSessionToken}` }]) {
    expect((await publicRequest(browserPath, headers)).status).toBe(401)
    expect(await loadState(attempt)).toEqual(before)
  }
  const wrong = await publicRequest(browserPath, { cookie: ownerCookie, authorization: `Bearer ${memberSessionToken}` })
  expect(wrong.status).toBe(403)
  expect(await wrong.json()).toMatchObject({ error: "browser_account_mismatch" })
  expect(await loadState(attempt)).toEqual(before)
  expect((await browserRequest(`/v1/inference-providers/oauth/callback?code=unused&state=${attempt}`)).status).toBe(400)
  expect(await loadState(attempt)).toEqual(before)
  const continued = await publicRequest(browserPath, { cookie: memberCookie, accept: "application/json" })
  expect(continued.status).toBe(200)
  expect(continued.headers.get("cache-control")).toBe("no-store")
  const next: unknown = await continued.json()
  if (!isRecord(next)) throw new Error("Google URL missing")
  const google = new URL(readString(next, "authUrl"))
  const state = google.searchParams.get("state") ?? ""
  expect(state).toMatch(/^google\./)
  expect(await loadState(attempt)).toBeNull()
  expect((await loadState(state))?.id).toBe(before?.id)
  expect((await publicRequest(browserPath, { cookie: memberCookie })).status).toBe(400)
  await db.delete(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
})

async function startBrowserEntry() {
  const response = await publicRequest(`/v1/inference-providers/${inferenceProviderId}/oauth/start?credentialSetId=${credentialSetId}`, { authorization: `Bearer ${memberSessionToken}`, accept: "application/json" })
  expect(response.status).toBe(200)
  const payload: unknown = await response.json()
  if (!isRecord(payload)) throw new Error("Entry missing")
  const attempt = new URL(readString(payload, "authUrl")).searchParams.get("attempt")
  if (!attempt) throw new Error("Entry attempt missing")
  return attempt
}

async function browserStatus(attempt: string, headers?: HeadersInit) {
  const response = await publicRequest(`/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(attempt)}`, headers)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("location")).toBeNull()
  expect(response.headers.get("set-cookie")).toBeNull()
  return response
}

async function expectReadOnlyBrowserStatus(run: () => Promise<void>) {
  const snapshot = () => Promise.all([
    db.select().from(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.gateway_provider_id, inferenceProviderId)).orderBy(schema.GatewayProviderOauthStateTable.id),
    db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, inferenceProviderId)).orderBy(schema.GatewayProviderCredentialTable.id),
    db.select().from(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.userId, [memberUserId, ownerUserId])).orderBy(schema.AuthSessionTable.id),
    db.execute(drizzle.sql`select * from gateway_provider_oauth_states where gateway_provider_id = ${inferenceProviderId} order by id`).then(([rows]) => rows),
  ])
  const before = await snapshot()
  const realFetch = globalThis.fetch
  const unexpectedFetch = mock(async () => { throw new Error("Browser status must not contact Google or any upstream") })
  globalThis.fetch = Object.assign(unexpectedFetch, { preconnect: realFetch.preconnect })
  try {
    await run()
    expect(unexpectedFetch).not.toHaveBeenCalled()
    expect(await snapshot()).toEqual(before)
  } finally {
    globalThis.fetch = realFetch
  }
}

test("browser-status distinguishes signed-out, mismatched and matching signed cookies without side effects", async () => {
  const attempt = await startBrowserEntry()
  await expectReadOnlyBrowserStatus(async () => {
    for (let poll = 0; poll < 3; poll++) {
      for (const headers of [{}, { authorization: `Bearer ${memberSessionToken}` }, { cookie: `better-auth.session_token=${memberSessionToken}` }, { cookie: "better-auth.session_token=invalid.signature", authorization: `Bearer ${memberSessionToken}` }]) {
        const response = await browserStatus(attempt, headers)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: "sign_in_required" })
      }
      const mismatch = await browserStatus(attempt, { cookie: ownerCookie, authorization: `Bearer ${memberSessionToken}` })
      expect(mismatch.status).toBe(200)
      expect(await mismatch.json()).toEqual({ status: "account_mismatch" })
      const matching = await browserStatus(attempt, { cookie: memberCookie, authorization: `Bearer ${ownerSessionToken}` })
      expect(matching.status).toBe(200)
      expect(await matching.json()).toEqual({ status: "ready" })
    }
  })
  const continued = await publicRequest(`/v1/inference-providers/oauth/browser-start?attempt=${attempt}`, { cookie: memberCookie, accept: "application/json" })
  expect(continued.status).toBe(200)
  await expectReadOnlyBrowserStatus(async () => {
    const consumed = await browserStatus(attempt, { cookie: memberCookie })
    expect(consumed.status).toBe(400)
    expect(await consumed.json()).toEqual({ error: "oauth_entry_expired", message: "This connection attempt expired or was already used. Start Connect again." })
  })
})

test.each(["expired", "revoked"])("browser-status requires sign-in for a %s signed session even after a ready poll", async (invalidity) => {
  const attempt = await startBrowserEntry()
  const sessionId = createDenTypeId("session")
  const token = `ipo-status-browser-${sessionId}`
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  await db.insert(schema.AuthSessionTable).values({ id: sessionId, userId: memberUserId, token, expiresAt: new Date(Date.now() + 300_000) })
  const cookie = await serializeSignedCookie("openwork-den.session_token", token, secret)
  try {
    await expectReadOnlyBrowserStatus(async () => {
      const ready = await browserStatus(attempt, { cookie })
      expect(ready.status).toBe(200)
      expect(await ready.json()).toEqual({ status: "ready" })
    })
    if (invalidity === "expired") await db.update(schema.AuthSessionTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
    else await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
    await expectReadOnlyBrowserStatus(async () => {
      for (let poll = 0; poll < 2; poll++) {
        const response = await browserStatus(attempt, { cookie, authorization: `Bearer ${memberSessionToken}` })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: "sign_in_required" })
      }
    })
  } finally {
    await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, sessionId))
  }
})

test.each(["expired", "used", "invalid_payload", "unknown"])("browser-status rejects an %s entry without changing state", async (invalidity) => {
  const attempt = await startBrowserEntry()
  const where = drizzle.eq(schema.GatewayProviderOauthStateTable.state, attempt)
  if (invalidity === "expired") await db.update(schema.GatewayProviderOauthStateTable).set({ expires_at: new Date(Date.now() - 1000) }).where(where)
  if (invalidity === "used") await db.update(schema.GatewayProviderOauthStateTable).set({ used_at: new Date() }).where(where)
  if (invalidity === "invalid_payload") await db.update(schema.GatewayProviderOauthStateTable).set({ code_verifier: "{}" }).where(where)
  if (invalidity === "unknown") await db.delete(schema.GatewayProviderOauthStateTable).where(where)
  await expectReadOnlyBrowserStatus(async () => {
    for (const headers of [{}, { cookie: memberCookie }, { cookie: ownerCookie }]) {
      const response = await browserStatus(attempt, headers)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "oauth_entry_expired", message: "This connection attempt expired or was already used. Start Connect again." })
    }
  })
})

test("browser-status rejects malformed entry queries with the existing validation contract and no-store headers", async () => {
  await expectReadOnlyBrowserStatus(async () => {
    for (const attempt of ["", "entry.invalid", `google.${"a".repeat(43)}`, `entry.${"a".repeat(44)}`]) {
      const response = await browserStatus(attempt, { cookie: memberCookie })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: "invalid_request" })
    }
    const missing = await publicRequest("/v1/inference-providers/oauth/browser-status")
    expect(missing.status).toBe(400)
    expect(missing.headers.get("cache-control")).toBe("no-store")
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await missing.json()).toMatchObject({ error: "invalid_request" })
  })
})

test.each(["client", "client_removed", "grant", "member", "member_binding", "provider", "set", "group"])("browser-status rechecks current %s authorization before reporting ready", async (change) => {
  const attempt = await startBrowserEntry()
  await expectReadOnlyBrowserStatus(async () => {
    const response = await browserStatus(attempt, { cookie: memberCookie })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  })
  const providerWhere = drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId)
  const setWhere = drizzle.eq(schema.GatewayCredentialSetTable.id, credentialSetId)
  const memberWhere = drizzle.eq(schema.MemberTable.id, memberId)
  const grantsWhere = drizzle.eq(schema.GatewayProviderAccessTable.gateway_provider_id, inferenceProviderId)
  const groupsWhere = drizzle.eq(schema.GatewayModelGroupTable.gateway_provider_id, inferenceProviderId)
  const grants = await db.select().from(schema.GatewayProviderAccessTable).where(grantsWhere)
  const groups = await db.select().from(schema.GatewayModelGroupTable).where(groupsWhere)
  try {
    if (change === "client" || change === "client_removed") await db.update(schema.GatewayCredentialSetTable).set({ oauth_client_secret: change === "client" ? "fixture-status-changed-client" : null }).where(setWhere)
    if (change === "grant") await db.delete(schema.GatewayProviderAccessTable).where(grantsWhere)
    if (change === "member") await db.update(schema.MemberTable).set({ removedAt: new Date() }).where(memberWhere)
    if (change === "member_binding") await db.update(schema.GatewayProviderOauthStateTable).set({ org_membership_id: ownerMemberId }).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, attempt))
    if (change === "provider") await db.update(schema.GatewayProviderTable).set({ status: "disabled" }).where(providerWhere)
    if (change === "set") await db.update(schema.GatewayCredentialSetTable).set({ status: "disabled" }).where(setWhere)
    if (change === "group") await db.update(schema.GatewayModelGroupTable).set({ status: "disabled" }).where(groupsWhere)
    await expectReadOnlyBrowserStatus(async () => {
      for (let poll = 0; poll < 2; poll++) {
        const response = await browserStatus(attempt, { cookie: memberCookie })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual(change === "client" || change === "client_removed"
          ? { error: "oauth_configuration_changed", message: "Provider configuration changed. Start Connect again." }
          : { error: "forbidden", message: "forbidden" })
      }
    })
    const continued = await publicRequest(`/v1/inference-providers/oauth/browser-start?attempt=${attempt}`, { cookie: memberCookie })
    expect(continued.status).toBe(403)
    expect((await loadState(attempt))?.used_at).toBeNull()
  } finally {
    if (change === "client" || change === "client_removed") await db.update(schema.GatewayCredentialSetTable).set({ oauth_client_secret: OAUTH_CLIENT_SECRET }).where(setWhere)
    if (change === "grant" && grants.length) await db.insert(schema.GatewayProviderAccessTable).values(grants)
    if (change === "member") await db.update(schema.MemberTable).set({ removedAt: null }).where(memberWhere)
    if (change === "member_binding") await db.update(schema.GatewayProviderOauthStateTable).set({ org_membership_id: memberId }).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, attempt))
    if (change === "provider") await db.update(schema.GatewayProviderTable).set({ status: "active" }).where(providerWhere)
    if (change === "set") await db.update(schema.GatewayCredentialSetTable).set({ status: "active" }).where(setWhere)
    if (change === "group") for (const group of groups) await db.update(schema.GatewayModelGroupTable).set({ status: group.status }).where(drizzle.eq(schema.GatewayModelGroupTable.id, group.id))
  }
})

test("browser-status is documented as public with the three readiness states", async () => {
  const response = await publicRequest("/openapi.json")
  expect(response.status).toBe(200)
  const document: unknown = await response.json()
  if (!isRecord(document) || !isRecord(document.paths)) throw new Error("OpenAPI paths missing")
  expect(document.paths["/v1/inference-providers/oauth/browser-status"]).toMatchObject({
    get: {
      security: [],
      "x-mcp": false,
      parameters: [{ name: "attempt", in: "query", required: true }],
      responses: {
        "200": { content: { "application/json": { schema: { properties: { status: { enum: ["sign_in_required", "account_mismatch", "ready"] } }, required: ["status"] } } } },
        "400": { description: "Invalid request or provider configuration." },
        "403": { description: "Provider access or OAuth configuration changed." },
      },
    },
  })
})

test("browser entry expires and client configuration cannot change before browser consent", async () => {
  for (const change of ["expiry", "client"]) {
    const response = await publicRequest(`/v1/inference-providers/${inferenceProviderId}/oauth/start`, { cookie: memberCookie, accept: "application/json" })
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error("Entry missing")
    const attempt = new URL(readString(payload, "authUrl")).searchParams.get("attempt") ?? ""
    if (change === "expiry") await db.update(schema.GatewayProviderOauthStateTable).set({ expires_at: new Date(Date.now() - 1000) }).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, attempt))
    else await db.update(schema.GatewayCredentialSetTable).set({ oauth_client_secret: "fixture-changed-client" }).where(drizzle.eq(schema.GatewayCredentialSetTable.id, credentialSetId))
    try {
      const started = await publicRequest(`/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`, { cookie: memberCookie })
      expect(started.status).toBe(change === "expiry" ? 400 : 403)
      expect((await loadState(attempt))?.used_at).toBeNull()
    } finally {
      await db.update(schema.GatewayCredentialSetTable).set({ oauth_client_secret: OAUTH_CLIENT_SECRET }).where(drizzle.eq(schema.GatewayCredentialSetTable.id, credentialSetId))
      await db.delete(schema.GatewayProviderOauthStateTable).where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, attempt))
    }
  }
})

test("Google token parsing requires durable offline access, bounded positive expiry, bearer and requested scopes", async () => {
  const { parseGoogleAuthorizationTokens } = await import("../src/llm/inference-provider-google-oauth.js")
  const valid = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, id_token: "fixture-id-token" }
  expect(parseGoogleAuthorizationTokens(valid).scope).toBe(GOOGLE_SCOPES)
  expect(parseGoogleAuthorizationTokens({ ...valid, expires_in: 86400 }).expires_in).toBe(86400)
  expect(parseGoogleAuthorizationTokens({ ...valid, access_token: "Az09-._~+/==" }).access_token).toBe("Az09-._~+/==")
  expect(parseGoogleAuthorizationTokens({ ...valid, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform" }).refresh_token).toBe("fixture-refresh")
  const invalid = [
    { access_token: "" }, { access_token: " " }, { access_token: "bad token" }, { access_token: "non-ascii-é" }, { access_token: "control\u0000byte" }, { access_token: "bad=padding=value" }, { access_token: "bad!token" }, { access_token: "bad\r\nheader" }, { refresh_token: "non-ascii-é" }, { token_type: undefined }, { token_type: "Basic" },
    { expires_in: undefined }, { expires_in: 0 }, { expires_in: -1 }, { expires_in: Infinity }, { expires_in: NaN }, { expires_in: 86401 }, { expires_in: "3600" },
    { refresh_token: undefined }, { refresh_token: "" }, { id_token: undefined }, { scope: "" }, { scope: "openid email" },
    { scope: "https://www.googleapis.com/auth/cloud-platform" },
  ]
  for (const fields of invalid) expect(() => parseGoogleAuthorizationTokens({ ...valid, ...fields })).toThrow()
})

test("Google OIDC verifies signature, issuer, audience, expiry, nonce, verified email and authorized party", async () => {
  const { verifyGoogleIdentity, googleOAuthNonce } = await import("../src/llm/inference-provider-google-oauth.js")
  const nonce = googleOAuthNonce("fixture-secret-verifier", "fixture-state")
  expect(nonce).not.toBe(googleOAuthNonce("other-verifier", "fixture-state"))
  expect(nonce).not.toBe(googleOAuthNonce("fixture-secret-verifier", "other-state"))
  const keyResolver = createLocalJWKSet({ keys: [await googlePublicJwk] })
  const verify = async (claims: JWTPayload) => verifyGoogleIdentity({ idToken: await googleIdToken({ nonce, ...claims }), clientId: OAUTH_CLIENT_ID, nonce, keyResolver })
  expect(await verify({})).toEqual({ subject: "fixture-google-subject", email: "google-account@example.test", emailVerified: true, clientId: OAUTH_CLIENT_ID })
  expect(await verify({ iss: "accounts.google.com" })).toMatchObject({ subject: "fixture-google-subject" })
  expect(await verify({ aud: [OAUTH_CLIENT_ID, "second-client"], azp: OAUTH_CLIENT_ID })).toMatchObject({ clientId: OAUTH_CLIENT_ID })
  for (const claims of [
    { iss: "https://untrusted.example.test" }, { aud: "wrong-client" }, { nonce: "wrong-nonce" }, { exp: 1 }, { sub: "" },
    { iat: Math.floor(Date.now() / 1000) + 3600 }, { email_verified: false }, { email_verified: "true" }, { email: "" },
    { aud: [OAUTH_CLIENT_ID, "second-client"] }, { azp: "second-client" }, { nonce: undefined }, { exp: undefined },
  ]) await expect(verify(claims)).rejects.toMatchObject({ code: "oauth_identity_invalid" })
  const wrongKey = await generateKeyPair("RS256")
  const wrongToken = await new SignJWT({ iss: "https://accounts.google.com", aud: OAUTH_CLIENT_ID, nonce, sub: "fixture", email: "test@example.test", email_verified: true })
    .setIssuedAt().setExpirationTime("1h").setProtectedHeader({ alg: "RS256", kid: "fixture-google" }).sign(wrongKey.privateKey)
  await expect(verifyGoogleIdentity({ idToken: wrongToken, clientId: OAUTH_CLIENT_ID, nonce, keyResolver })).rejects.toMatchObject({ code: "oauth_identity_invalid" })
})

test("Google OIDC distinguishes recognizable key-fetch outages without exposing infrastructure details", async () => {
  const { verifyGoogleIdentity } = await import("../src/llm/inference-provider-google-oauth.js")
  const idToken = await googleIdToken({ nonce: "fixture-nonce" })
  for (const failure of [new errors.JWKSTimeout("PRIVATE_JWKS_DETAIL"), new TypeError("PRIVATE_JWKS_DETAIL"), new DOMException("PRIVATE_JWKS_DETAIL", "AbortError")]) {
    await expect(verifyGoogleIdentity({ idToken, clientId: OAUTH_CLIENT_ID, nonce: "fixture-nonce", keyResolver: async () => { throw failure } })).rejects.toMatchObject({
      code: "oauth_identity_unavailable", message: "Google account verification is temporarily unavailable. Try Connect again later.",
    })
  }
})

test("Google exchange classifies safe repair reasons without provider payloads", async () => {
  const { exchangeGoogleAuthorizationCode } = await import("../src/llm/inference-provider-google-oauth.js")
  for (const [status, error, subtype, code] of [
    [400, "invalid_client", "", "oauth_invalid_client"], [400, "invalid_grant", "invalid_rapt", "oauth_reauthentication_required"],
    [400, "invalid_grant", "", "oauth_invalid_grant"], [429, "limited", "", "oauth_token_endpoint_unavailable"], [503, "failed", "", "oauth_token_endpoint_unavailable"],
  ] as const) {
    await expect(exchangeGoogleAuthorizationCode({ clientId: OAUTH_CLIENT_ID, clientSecret: "fixture", code: "fixture", codeVerifier: "fixture", redirectUri: `${API_ORIGIN}/v1/inference-providers/oauth/callback`,
      fetchImpl: async () => Response.json({ error, error_subtype: subtype, error_description: "PRIVATE_PROVIDER_PAYLOAD" }, { status }),
    })).rejects.toMatchObject({ code })
  }
})

test.each(["google-vertex", "google-vertex-anthropic"])("%s supports verified authorization, safe reconnect and disconnect after access loss", async (providerId) => {
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Lifecycle fixture", providerId, modelIds: [providerId === "google-vertex" ? "gemini-2.5-pro" : "claude-sonnet-4"], settings: { project: "test-project", location: "us-central1" }, credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET, allMembers: true }) })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const setId = readString(defaultSet(provider), "id")
  const base = `/v1/inference-providers/${id}`
  const credentials = () => db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, id))
  const authorize = async (cookie: string, subject: string, refreshToken?: string) => {
    const start = await request(cookie, `${base}/oauth/start?credentialSetId=${setId}`)
    expect(start.status).toBe(302)
    const url = new URL(start.headers.get("location") ?? "")
    const state = url.searchParams.get("state") ?? ""
    return withFakeGoogle(async () => Response.json({ access_token: "fixture-new-access", refresh_token: refreshToken, expires_in: 3600, id_token: await googleIdToken({ sub: subject, nonce: url.searchParams.get("nonce") }) }), async () => browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${state}`, cookie))
  }
  expect((await authorize(memberCookie, "fixture-initial", undefined)).status).toBe(400)
  expect(await credentials()).toEqual([])
  expect((await authorize(memberCookie, "fixture-initial", "fixture-initial-refresh")).status).toBe(200)
  const before = await credentials()
  for (const subject of ["fixture-initial", "fixture-switched"]) {
    const reconnect = await authorize(memberCookie, subject, undefined)
    expect(reconnect.status).toBe(400)
    expect(await reconnect.text()).toContain("offline access")
    expect(await credentials()).toEqual(before)
  }
  expect((await authorize(memberCookie, "fixture-switched", "fixture-switched-refresh")).status).toBe(200)
  const switched = (await credentials())[0]
  expect(JSON.parse(switched?.secret ?? "{}")).toMatchObject({ refreshToken: "fixture-switched-refresh", googleIdentity: { subject: "fixture-switched" } })
  if (!switched) throw new Error("Credential missing")
  const { gatewayMemberConnectionsResponseSchema } = await import("@openwork/types/den/inference")
  const memberConnection = async () => {
    const response = await request(memberCookie, "/v1/inference-providers/member-connections")
    expect(response.status).toBe(200)
    const text = await response.text()
    for (const hidden of ["last_error", "invalid_client", "fixture-new-access", "fixture-switched-refresh", OAUTH_CLIENT_SECRET]) expect(text).not.toContain(hidden)
    return gatewayMemberConnectionsResponseSchema.parse(JSON.parse(text)).connections.find((connection) => connection.providerId === id && connection.credentialSetId === setId)
  }
  for (const expires_at of [switched.expires_at, new Date(Date.now() - 1000)]) {
    await db.update(schema.GatewayProviderCredentialTable).set({ status: "active", last_error: "invalid_client", expires_at }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, switched.id))
    expect(await memberConnection()).toMatchObject({ configurationRequired: true, ready: false, hasAccess: true, hasCredential: true })
    const blockedSummary = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
    expect(blockedSummary).toMatchObject({ credentialStatus: "member_auth_required", models: [] })
    expect((await credentials()).find((row) => row.id === switched.id)?.status).toBe("active")
  }
  expect((await authorize(memberCookie, "fixture-switched", "fixture-switched-refresh")).status).toBe(200)
  expect((await credentials()).find((row) => row.id === switched.id)?.last_error).toBeNull()
  expect(await memberConnection()).toMatchObject({ configurationRequired: false, ready: true, hasCredential: true })
  expect(readProvider(await (await request(memberCookie, `${base}/connect`)).json()).credentialStatus).toBe("ready")
  await db.update(schema.GatewayProviderCredentialTable).set({ last_error: "invalid_client" }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, switched.id))
  await withFakeGoogle(() => new Response(null, { status: 200 }), async () => {
    expect((await request(ownerCookie, `${base}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ oauthClientSecret: "fixture-repaired-client-secret" }) })).status).toBe(200)
  })
  expect(await memberConnection()).toMatchObject({ configurationRequired: false, ready: false, hasAccess: true, hasCredential: false })
  expect((await credentials()).find((row) => row.id === switched.id)).toMatchObject({ status: "revoked", last_error: null })
  expect((await authorize(memberCookie, "fixture-switched", "fixture-switched-refresh")).status).toBe(200)
  await db.update(schema.GatewayProviderCredentialTable).set({ expires_at: null }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, switched.id))
  const legacy = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  expect(legacy.credentialStatus).toBe("member_auth_required")
  await db.update(schema.GatewayProviderCredentialTable).set({ expires_at: switched.expires_at }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, switched.id))
  expect((await authorize(ownerCookie, "fixture-other-member", "fixture-other-refresh")).status).toBe(200)
  const other = (await credentials()).find((row) => row.org_membership_id === ownerMemberId)
  await db.delete(schema.GatewayProviderAccessTable).where(drizzle.eq(schema.GatewayProviderAccessTable.gateway_provider_id, id))
  await db.update(schema.GatewayProviderTable).set({ status: "disabled" }).where(drizzle.eq(schema.GatewayProviderTable.id, id))
  await withFakeGoogle(() => new Response("PRIVATE_REVOCATION_PAYLOAD", { status: 503 }), async (calls) => {
    expect((await request(memberCookie, `${base}/oauth?credentialSetId=${setId}`, { method: "DELETE" })).status).toBe(204)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.get("token")).toBe("fixture-switched-refresh")
  })
  expect((await credentials()).find((row) => row.org_membership_id === memberId)).toMatchObject({ status: "revoked", secret: "{}", expires_at: null, scopes: null })
  expect((await credentials()).find((row) => row.org_membership_id === ownerMemberId)).toEqual(other)
})

test("member inventory isolates mixed sets, verified identity and completed-authorization revisions through access loss", async () => {
  const { gatewayMemberConnectionsResponseSchema, inferenceOauthTokenSecretSchema } = await import("@openwork/types/den/inference")
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Mixed inventory fixture", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "test-project", location: "us-central1" }, credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET, allMembers: true }) })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const firstSetId = readString(defaultSet(provider), "id")
  if (!Array.isArray(provider.modelGroups) || !isRecord(provider.modelGroups[0])) throw new Error("Group missing")
  const groupId = readString(provider.modelGroups[0], "id")
  const base = `/v1/inference-providers/${id}`
  const addSet = async (name: string, mode: "org" | "member", ownerOnly = false) => {
    const response = await request(ownerCookie, `${base}/credential-sets`, { method: "POST", body: JSON.stringify({ name, credentialMode: mode, ...(mode === "org" ? { credential: { kind: "api_key", secret: "fixture-org-only-secret" } } : { oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET }) }) })
    expect(response.status).toBe(201)
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !isRecord(payload.credentialSet)) throw new Error("Set missing")
    const setId = readString(payload.credentialSet, "id")
    expect((await request(ownerCookie, `${base}/access-grants`, { method: "POST", body: JSON.stringify({ modelGroupId: groupId, credentialSetId: setId, audience: ownerOnly ? { type: "member", memberId: ownerMemberId } : { type: "organization" } }) })).status).toBe(201)
    return setId
  }
  const pendingSetId = await addSet("Pending member set", "member")
  const orgSetId = await addSet("Shared set", "org")
  const privateSetId = await addSet("Other member private set", "member", true)
  const foreignOrg = createDenTypeId("organization")
  const foreignCredential = createDenTypeId("inferenceProviderCredential")
  await db.insert(schema.OrganizationTable).values({ id: foreignOrg, name: "Foreign inventory fixture", slug: foreignOrg })
  await db.insert(schema.GatewayProviderCredentialTable).values([
    { id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: id, credential_set_id: privateSetId, organization_id: organizationId, subject: ownerMemberId, org_membership_id: ownerMemberId, kind: "oauth_google", status: "active", secret: JSON.stringify({ accessToken: "fixture-private-access", refreshToken: "fixture-private-refresh", googleIdentity: { subject: "fixture-private-sub", email: "private@example.test", emailVerified: true, clientId: OAUTH_CLIENT_ID } }), expires_at: new Date(Date.now() + 3600_000) },
    { id: foreignCredential, gateway_provider_id: id, credential_set_id: pendingSetId, organization_id: foreignOrg, subject: memberId, org_membership_id: memberId, kind: "oauth_google", status: "active", secret: JSON.stringify({ accessToken: "fixture-foreign-access", refreshToken: "fixture-foreign-refresh", googleIdentity: { subject: "fixture-foreign-sub", email: "foreign@example.test", emailVerified: true, clientId: OAUTH_CLIENT_ID } }), expires_at: new Date(Date.now() + 3600_000) },
  ])
  const inventory = async (cookie = memberCookie) => {
    const response = await request(cookie, "/v1/inference-providers/member-connections")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const text = await response.text()
    for (const hidden of [OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, "fixture-private-access", "fixture-foreign-access", "fixture-inventory-access", "fixture-inventory-refresh", "fixture-inventory-sub", "fixture-private-sub", "fixture-foreign-sub", "fixture-org-only-secret"]) expect(text).not.toContain(hidden)
    if (cookie === memberCookie) {
      for (const hidden of [privateSetId, "private@example.test", "foreign@example.test"]) expect(text).not.toContain(hidden)
    }
    const payload = gatewayMemberConnectionsResponseSchema.parse(JSON.parse(text))
    return payload.connections.filter((connection) => connection.providerId === id)
  }
  const authorize = async () => {
    const start = await request(memberCookie, `${base}/oauth/start?credentialSetId=${firstSetId}`)
    const url = new URL(start.headers.get("location") ?? "")
    const state = url.searchParams.get("state") ?? ""
    await withFakeGoogle(async () => Response.json({ access_token: "fixture-inventory-access", refresh_token: "fixture-inventory-refresh", expires_in: 3600, id_token: await googleIdToken({ sub: "fixture-inventory-sub", nonce: url.searchParams.get("nonce"), email: "connected@example.test" }) }), async () => {
      expect((await browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${state}`)).status).toBe(200)
    })
  }
  const { env } = await import("../src/env.js")
  const previousEnabled = env.gatewayEnabled
  try {
    expect((await publicRequest("/v1/inference-providers/member-connections")).status).toBe(401)
    env.gatewayEnabled = false
    const empty = await inventory()
    expect(empty).toHaveLength(2)
    for (const connection of empty) expect(connection).toMatchObject({ ready: false, hasAccess: true, hasCredential: false, authorizationRevision: null, accountEmail: null })
    expect(empty.some((connection) => connection.credentialSetId === orgSetId)).toBe(false)
    await authorize()
    const connected = await inventory()
    const first = connected.find((connection) => connection.credentialSetId === firstSetId)
    expect(first).toEqual({ providerId: id, credentialSetId: firstSetId, providerName: "Mixed inventory fixture", name: "Default credentials", ready: true, hasAccess: true, hasCredential: true, configurationRequired: false, authorizationRevision: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), accountEmail: "connected@example.test" })
    expect(connected.find((connection) => connection.credentialSetId === pendingSetId)).toMatchObject({ ready: false, hasCredential: false, authorizationRevision: null, accountEmail: null })
    const ownerView = await inventory(ownerCookie)
    expect(ownerView.find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, hasCredential: false, accountEmail: null, authorizationRevision: null })
    expect(ownerView.find((connection) => connection.credentialSetId === privateSetId)).toMatchObject({ ready: true, hasCredential: true, accountEmail: "private@example.test", authorizationRevision: null })
    const [credential] = await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.and(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, firstSetId), drizzle.eq(schema.GatewayProviderCredentialTable.subject, memberId)))
    if (!credential) throw new Error("Credential missing")
    const token = inferenceOauthTokenSecretSchema.parse(JSON.parse(credential.secret))
    await db.update(schema.GatewayProviderCredentialTable).set({ last_error: "invalid_client" }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, configurationRequired: true, hasCredential: true })
    expect((await inventory()).find((connection) => connection.credentialSetId === pendingSetId)).toMatchObject({ configurationRequired: false })
    expect((await inventory(ownerCookie)).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ configurationRequired: false, hasCredential: false })
    const mixedSummary = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
    if (!Array.isArray(mixedSummary.models)) throw new Error("Models missing")
    expect(mixedSummary.models.some((model: unknown) => isRecord(model) && model.credentialSetId === firstSetId)).toBe(false)
    expect(mixedSummary.models.some((model: unknown) => isRecord(model) && model.credentialSetId === orgSetId)).toBe(true)
    await db.update(schema.GatewayProviderCredentialTable).set({ last_error: "temporarily_unavailable" }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: true, configurationRequired: false })
    await db.update(schema.GatewayProviderCredentialTable).set({ last_error: null, expires_at: null }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, hasCredential: true })
    await db.update(schema.GatewayProviderCredentialTable).set({ expires_at: credential.expires_at, secret: JSON.stringify({ ...token, accessToken: "invalid-ascii-é" }) }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, hasCredential: true })
    await db.update(schema.GatewayProviderCredentialTable).set({ secret: JSON.stringify({ ...token, googleIdentity: { ...token.googleIdentity, emailVerified: false } }) }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, hasCredential: true, accountEmail: null, authorizationRevision: null })
    await db.update(schema.GatewayProviderCredentialTable).set({ secret: JSON.stringify({ ...token, accessToken: "fixture-refreshed-access", refreshToken: "fixture-rotated-refresh" }), last_refreshed_at: new Date(), updated_at: new Date(), expires_at: new Date(Date.now() + 3500_000) }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)?.authorizationRevision).toBe(first?.authorizationRevision)
    await authorize()
    const reconnected = (await inventory()).find((connection) => connection.credentialSetId === firstSetId)
    expect(reconnected?.authorizationRevision).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reconnected?.authorizationRevision).not.toBe(first?.authorizationRevision)
    await db.update(schema.GatewayProviderCredentialTable).set({ status: "refresh_failed", last_error: "invalid_grant" }).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, credential.id))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, configurationRequired: false, hasAccess: true, hasCredential: true, accountEmail: "connected@example.test", authorizationRevision: reconnected?.authorizationRevision })
    await db.delete(schema.GatewayProviderAccessTable).where(drizzle.eq(schema.GatewayProviderAccessTable.credential_set_id, firstSetId))
    expect((await inventory()).find((connection) => connection.credentialSetId === firstSetId)).toMatchObject({ ready: false, hasAccess: false, hasCredential: true })
    await db.update(schema.GatewayProviderTable).set({ status: "disabled" }).where(drizzle.eq(schema.GatewayProviderTable.id, id))
    expect(await inventory()).toEqual([{ ...reconnected, ready: false, hasAccess: false, hasCredential: true }])
    await withFakeGoogle(() => new Response(null, { status: 200 }), async () => {
      expect((await request(memberCookie, `${base}/oauth?credentialSetId=${firstSetId}`, { method: "DELETE" })).status).toBe(204)
    })
    expect(await inventory()).toEqual([])
    expect((await inventory(ownerCookie)).find((connection) => connection.credentialSetId === privateSetId)).toMatchObject({ hasCredential: true, hasAccess: false })
  } finally {
    env.gatewayEnabled = previousEnabled
    await db.delete(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.id, foreignCredential))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, foreignOrg))
  }
})

test("revoked browser session during exchange cannot persist a replacement", async () => {
  const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const before = await loadMemberCredential()
  try {
    await withFakeGoogle(async (call) => {
      if (call.url === GOOGLE_REVOKE_URL) return new Response(null, { status: 200 })
      await db.update(schema.AuthSessionTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
      return Response.json({ access_token: "fixture-session-loss", refresh_token: "fixture-session-loss-refresh", expires_in: 3600 })
    }, async (calls) => {
      expect((await browserRequest(`/v1/inference-providers/oauth/callback?code=fixture&state=${state}`)).status).toBe(400)
      expect(calls.some((call) => call.url === GOOGLE_REVOKE_URL)).toBe(true)
    })
    expect(await loadMemberCredential()).toEqual(before)
  } finally {
    await db.update(schema.AuthSessionTable).set({ expiresAt: new Date(Date.now() + 300_000) }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
  }
})
