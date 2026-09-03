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
  handler: (call: GoogleCall) => Response,
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
      settings: { project: "p", location: "us-central1" },
      credentialMode: "member",
      oauthClientId: OAUTH_CLIENT_ID,
      oauthClientSecret: OAUTH_CLIENT_SECRET,
      allMembers: true,
    }),
  })
  expect(createResponse.status).toBe(201)
  inferenceProviderId = readString(readProvider(await createResponse.json()), "id")
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }
  const inferenceProviderIds = db
    .select({ id: schema.InferenceProviderTable.id })
    .from(schema.InferenceProviderTable)
    .where(drizzle.eq(schema.InferenceProviderTable.organization_id, organizationId))
  await db.delete(schema.InferenceProviderOauthStateTable).where(drizzle.inArray(schema.InferenceProviderOauthStateTable.inference_provider_id, inferenceProviderIds))
  await db.delete(schema.InferenceProviderAccessTable).where(drizzle.inArray(schema.InferenceProviderAccessTable.inference_provider_id, inferenceProviderIds))
  await db.delete(schema.InferenceProviderModelTable).where(drizzle.inArray(schema.InferenceProviderModelTable.inference_provider_id, inferenceProviderIds))
  await db.delete(schema.InferenceProviderCredentialTable).where(drizzle.eq(schema.InferenceProviderCredentialTable.organization_id, organizationId))
  await db.delete(schema.InferenceProviderTable).where(drizzle.eq(schema.InferenceProviderTable.organization_id, organizationId))
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
    .from(schema.InferenceProviderOauthStateTable)
    .where(drizzle.eq(schema.InferenceProviderOauthStateTable.state, state))
    .then((rows) => rows[0] ?? null)
}

function loadMemberCredential() {
  return db
    .select()
    .from(schema.InferenceProviderCredentialTable)
    .where(drizzle.and(
      drizzle.eq(schema.InferenceProviderCredentialTable.inference_provider_id, inferenceProviderId),
      drizzle.eq(schema.InferenceProviderCredentialTable.subject, memberId),
    ))
    .then((rows) => rows[0] ?? null)
}

test("member-mode create/patch requires a Google provider and an OAuth client", async () => {
  const missingClient = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "No Client",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      settings: { project: "p", location: "us-central1" },
      credentialMode: "member",
      oauthClientId: OAUTH_CLIENT_ID,
    }),
  })
  expect(missingClient.status).toBe(400)
  await expect(missingClient.json()).resolves.toMatchObject({ error: "oauth_client_required" })

  // Org mode never needs the client; flipping to member mode later validates the stored row.
  const orgMode = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Org Vertex", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "p", location: "us-central1" }, allMembers: true }),
  })
  expect(orgMode.status).toBe(201)
  const orgProvider = readProvider(await orgMode.json())
  expect(orgProvider).toMatchObject({ oauthClientId: null, hasOauthClientSecret: false })
  const orgProviderId = readString(orgProvider, "id")

  // Org-mode providers have no member sign-in.
  const orgStart = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(orgStart.status).toBe(400)
  await expect(orgStart.json()).resolves.toMatchObject({ error: "unsupported_credential_mode" })

  const flip = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "member" }),
  })
  expect(flip.status).toBe(400)
  await expect(flip.json()).resolves.toMatchObject({ error: "oauth_client_required" })
  const flipWithClient = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: OAUTH_CLIENT_SECRET }),
  })
  expect(flipWithClient.status).toBe(200)
  expect(readProvider(await flipWithClient.json())).toMatchObject({ credentialMode: "member", oauthClientId: OAUTH_CLIENT_ID, hasOauthClientSecret: true })
  const memberStart = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(memberStart.status).toBe(302)

  // Switching back to org mode may drop the secret; the client id is kept for later.
  const backToOrg = await request(ownerCookie, `/v1/inference-providers/${orgProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ credentialMode: "org", oauthClientSecret: "" }),
  })
  expect(backToOrg.status).toBe(200)
  expect(readProvider(await backToOrg.json())).toMatchObject({ credentialMode: "org", oauthClientId: OAUTH_CLIENT_ID, hasOauthClientSecret: false })
  const orgStartAfter = await request(memberCookie, `/v1/inference-providers/${orgProviderId}/oauth/start`)
  expect(orgStartAfter.status).toBe(400)
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
  expect(stateRow).toMatchObject({ inference_provider_id: inferenceProviderId, org_membership_id: memberId, redirect_to: null, used_at: null })
  expect(stateRow.expires_at.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000)
  expect(stateRow.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  // The verifier is stored encrypted at rest.
  const [raw] = await db.execute(drizzle.sql`select code_verifier from inference_provider_oauth_states where state = ${state}`)
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
  expect(readString(before, "authUrl")).toMatch(new RegExp(`/v1/inference-providers/${inferenceProviderId}/oauth/start$`))

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
  const [rawCredential] = await db.execute(drizzle.sql`select secret from inference_provider_credentials where id = ${credential.id}`)
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
    .update(schema.InferenceProviderOauthStateTable)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.InferenceProviderOauthStateTable.state, state))
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
    () => Response.json({ error: "invalid_grant", error_description: "Bad code" }, { status: 400 }),
    async () => {
      const failed = await publicRequest(`/v1/inference-providers/oauth/callback?code=bad&state=${encodeURIComponent(failedState)}`)
      expect(failed.status).toBe(302)
      const location = new URL(failed.headers.get("location") ?? "")
      expect(location.searchParams.get("error")).toContain("invalid_grant")
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
  // Re-consent replaces the member row (unique per provider+subject) and keeps a single credential.
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
  expect(ownerDelete.status).toBe(404)

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
  expect(again.status).toBe(404)
})
