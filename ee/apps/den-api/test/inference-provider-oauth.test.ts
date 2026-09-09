import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"
const PROXY_BASE_URL = "https://inference.example.test"
const OAUTH_CLIENT_ID = "vertex-client.apps.googleusercontent.com"
const OAUTH_CLIENT_SECRET = "GOCSPX-vertex-client-secret"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_inference_providers"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "w".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.INFERENCE_PROXY_BASE_URL = `${PROXY_BASE_URL}/`
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

function defaultSet(provider: Record<string, unknown>) {
  if (!Array.isArray(provider.credentialSets) || !isRecord(provider.credentialSets[0])) throw new Error("credentialSets missing")
  return provider.credentialSets[0]
}

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("cookie", cookie)
  headers.set("origin", API_ORIGIN)
  if (init.body) headers.set("content-type", "application/json")
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers, redirect: "manual" }))
}

function publicRequest(path: string) {
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { redirect: "manual" }))
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

type GoogleCall = { url: string; body: URLSearchParams }

/** Replaces global fetch for Google's token/revoke endpoints; everything else fails loudly. */
function withFakeGoogle<T>(
  handler: (call: GoogleCall) => Response | Promise<Response>,
  run: (calls: GoogleCall[]) => Promise<T>,
) {
  const calls: GoogleCall[] = []
  const realFetch = globalThis.fetch
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url !== GOOGLE_TOKEN_URL && url !== GOOGLE_REVOKE_URL) {
      throw new Error(`unexpected fetch ${url}`)
    }
    const body = init?.body
    const params = body instanceof URLSearchParams ? body : new URLSearchParams(typeof body === "string" ? body : "")
    const call = { url, body: params }
    calls.push(call)
    return handler(call)
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
    getModelsDevProvider: async (providerId: string) => (providerId === "google-vertex" ? vertexCatalog : null),
    listModelsDevProviders: async () => [],
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
  expect(missingClient.status).toBe(201)
  expect(defaultSet(readProvider(await missingClient.json()))).toMatchObject({ configured: false, credentialStatus: "member_auth_required" })

  // Org mode never needs the client; flipping to member mode later validates the stored row.
  const orgMode = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Org Vertex", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "test-project", location: "us-central1" }, allMembers: true }),
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

  // Switching back to org mode may drop the secret; the client id is kept for later.
  const backToOrg = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}/credential-sets/${setId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "org", oauthClientSecret: "" }),
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

test("oauth/start redirects to Google with PKCE + offline params and records a state row; JSON variant returns authUrl", async () => {
  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  expect(startResponse.status).toBe(302)
  const location = startResponse.headers.get("location")
  if (!location) throw new Error("missing location")
  const authorize = new URL(location)
  expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
  expect(authorize.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID)
  expect(authorize.searchParams.get("response_type")).toBe("code")
  expect(authorize.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform")
  expect(authorize.searchParams.get("access_type")).toBe("offline")
  expect(authorize.searchParams.get("prompt")).toBe("consent")
  expect(authorize.searchParams.get("include_granted_scopes")).toBe("true")
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
  expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(authorize.searchParams.get("hd")).toBe("example.test")
  const redirectUri = authorize.searchParams.get("redirect_uri")
  expect(redirectUri).toMatch(/^https?:\/\/.+\/v1\/inference-providers\/oauth\/callback$/)
  expect(location).not.toContain(OAUTH_CLIENT_SECRET)

  const state = authorize.searchParams.get("state")
  if (!state) throw new Error("missing state")
  const stateRow = await loadState(state)
  if (!stateRow) throw new Error("state row missing")
  expect(stateRow).toMatchObject({ gateway_provider_id: inferenceProviderId, credential_set_id: credentialSetId, org_membership_id: memberId, redirect_to: null, used_at: null })
  expect(stateRow.expires_at.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000)
  expect(stateRow.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
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
  expect(before).toMatchObject({ credentialStatus: "member_auth_required" })
  expect(new URL(readString(before, "authUrl")).searchParams.get("credentialSetId")).toBe(credentialSetId)

  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
  const authorize = new URL(startResponse.headers.get("location") ?? "")
  const state = authorize.searchParams.get("state") ?? ""
  const codeChallenge = authorize.searchParams.get("code_challenge")
  const redirectUri = authorize.searchParams.get("redirect_uri")

  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.access", refresh_token: "1//refresh", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/cloud-platform" }),
    async (calls) => {
      const callback = await publicRequest(`/v1/inference-providers/oauth/callback?code=4/auth-code&state=${encodeURIComponent(state)}`)
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
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  })
  expect(JSON.parse(credential.secret)).toEqual({ accessToken: "ya29.access", refreshToken: "1//refresh", tokenType: "Bearer" })
  const expiresIn = (credential.expires_at?.getTime() ?? 0) - Date.now()
  expect(expiresIn).toBeGreaterThan(3500 * 1000)
  expect(expiresIn).toBeLessThanOrEqual(3600 * 1000)
  const [rawCredential] = await db.execute(drizzle.sql`select secret from gateway_provider_credentials where id = ${credential.id}`)
  expect(JSON.stringify(rawCredential)).not.toContain("ya29.access")

  const after = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(after).toMatchObject({ credentialStatus: "ready", authUrl: null })
  // Only the member who consented is ready; the owner still needs to sign in.
  const ownerConnect = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(ownerConnect).toMatchObject({ credentialStatus: "member_auth_required" })

  // Replaying the same state never reaches Google.
  await withFakeGoogle(
    () => { throw new Error("must not exchange") },
    async (calls) => {
      const replay = await publicRequest(`/v1/inference-providers/oauth/callback?code=4/again&state=${encodeURIComponent(state)}`)
      expect(replay.status).toBe(400)
      expect(await replay.text()).toContain("already used")
      expect(calls).toHaveLength(0)
    },
  )
})

test("callback rejects expired and unknown state, and redirects failures with error= when redirectTo was given", async () => {
  const unknown = await publicRequest("/v1/inference-providers/oauth/callback?code=x&state=not-a-state")
  expect(unknown.status).toBe(400)
  expect(await unknown.text()).toContain("expired or was already used")

  const missing = await publicRequest("/v1/inference-providers/oauth/callback?code=x")
  expect(missing.status).toBe(400)

  const startResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected?provider=1")}`)
  const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await db
    .update(schema.GatewayProviderOauthStateTable)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.GatewayProviderOauthStateTable.state, state))
  const expired = await publicRequest(`/v1/inference-providers/oauth/callback?code=x&state=${encodeURIComponent(state)}`)
  expect(expired.status).toBe(400)
  expect((await loadState(state))?.used_at).toBeNull()

  const deniedStart = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected?provider=1")}`)
  const deniedState = new URL(deniedStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const denied = await publicRequest(`/v1/inference-providers/oauth/callback?error=access_denied&state=${encodeURIComponent(deniedState)}`)
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
      const failed = await publicRequest(`/v1/inference-providers/oauth/callback?code=bad&state=${encodeURIComponent(failedState)}`)
      expect(failed.status).toBe(302)
      const location = new URL(failed.headers.get("location") ?? "")
      expect(location.searchParams.get("error")).toContain("OpenWork could not finish Google sign-in")
      expect(location.toString()).not.toContain("FAKE_TOKEN_MUST_NOT_ECHO")
    },
  )

  const successStart = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start?redirectTo=${encodeURIComponent("openwork://inference/connected")}`)
  const successState = new URL(successStart.headers.get("location") ?? "").searchParams.get("state") ?? ""
  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.second", expires_in: 3600 }),
    async () => {
      const success = await publicRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${encodeURIComponent(successState)}`)
      expect(success.status).toBe(302)
      expect(success.headers.get("location")).toBe("openwork://inference/connected")
    },
  )
  // Re-consent updates the member row (unique per set+subject) and keeps a single credential.
  const credential = await loadMemberCredential()
  expect(JSON.parse(credential?.secret ?? "{}")).toEqual({ accessToken: "ya29.second" })
  expect(credential?.scopes).toBe("https://www.googleapis.com/auth/cloud-platform")
})

test("DELETE oauth revokes the refresh token at Google and marks the credential revoked", async () => {
  await withFakeGoogle(
    () => Response.json({ access_token: "ya29.third", refresh_token: "1//refresh-third", expires_in: 3600 }),
    async () => {
      const start = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/oauth/start`)
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
      const callback = await publicRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${encodeURIComponent(state)}`)
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
      expect((await publicRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${state}`)).status).toBe(200)
    },
  )
  const mixed = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  expect(mixed).toMatchObject({ credentialStatus: "ready", models: [{ credentialSetId: firstSetId }], authorizationRequests: [{ credentialSetId: secondSetId }] })
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
      const callback = await publicRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${pendingState}`)
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
      expect((await publicRequest(`/v1/inference-providers/oauth/callback?code=ok&state=${lostAccessState}`)).status).toBe(400)
      expect(calls).toHaveLength(0)
    },
  )
  expect((await request(memberCookie, `${base}/oauth?credentialSetId=${secondSetId}`, { method: "DELETE" })).status).toBe(204)
  expect(readProvider(await (await request(memberCookie, `${base}/connect`)).json()).models).toMatchObject([{ credentialSetId: firstSetId }])
})
