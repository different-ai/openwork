import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { serializeSignedCookie } from "better-call"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { CachedAuthSession } from "../src/cache.js"

// Real-database coverage for sharing a device API key with an organization.
// Requires an isolated, schema-prepared MySQL database (see test:local-key-share:db).

const API_ORIGIN = "http://127.0.0.1:8790"
const PROXY_BASE_URL = "https://inference.example.test"
const SESSION_COOKIE = "better-auth.session_token"
const FRESH_SESSION_MAX_AGE_MS = 15 * 60 * 1000

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

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`${key} was not a string`)
  return value
}

function readShare(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.share)) throw new Error("Response did not include share")
  return {
    requestId: readString(payload.share, "requestId"),
    organizationId: readString(payload.share, "organizationId"),
    providerId: readString(payload.share, "providerId"),
    inferenceProviderId: normalizeDenTypeId("inferenceProvider", readString(payload.share, "inferenceProviderId")),
  }
}

function readError(payload: unknown) {
  if (!isRecord(payload)) throw new Error("Response was not an object")
  return { error: readString(payload, "error"), message: typeof payload.message === "string" ? payload.message : "" }
}

function readEligibility(payload: unknown) {
  if (!isRecord(payload) || typeof payload.eligible !== "boolean" || !Array.isArray(payload.teams)) throw new Error("Response was not an eligibility object")
  const teams = payload.teams.filter(isRecord).map((team) => ({ id: readString(team, "id"), name: readString(team, "name") }))
  return { organizationId: readString(payload, "organizationId"), memberId: readString(payload, "memberId"), organizationName: readString(payload, "organizationName"),
    eligible: payload.eligible, reason: typeof payload.reason === "string" ? payload.reason : null, teams }
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value)
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, into)
  else if (isRecord(value)) for (const entry of Object.values(value)) collectStrings(entry, into)
  else if (value instanceof Error) { into.push(value.message); collectStrings(value.cause, into) }
  return into
}

// Raw driver results differ by driver ([rows, fields] or { rows }); collect only the named column's string values.
function rawColumnValues(result: unknown, column: string, into: string[] = []): string[] {
  if (Array.isArray(result)) for (const entry of result) rawColumnValues(entry, column, into)
  else if (isRecord(result)) {
    const value = result[column]
    if (typeof value === "string") into.push(value)
    else for (const entry of Object.values(result)) rawColumnValues(entry, column, into)
  }
  return into
}

type SharePayload = { requestId: string; providerId: string; name: string; credential: { kind: "api_key"; secret: string }; allMembers: boolean; teamIds: string[] }

// Trusted catalog fixture: the share path must never reach models.dev or any upstream provider.
const catalog = {
  anthropic: {
    id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"], doc: null, api: null,
    config: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
    models: [
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", config: { id: "claude-sonnet-4", name: "Claude Sonnet 4" } },
      { id: "claude-haiku-4", name: "Claude Haiku 4", config: { id: "claude-haiku-4", name: "Claude Haiku 4" } },
    ],
  },
  openai: {
    id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], doc: null, api: null,
    config: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
    models: [{ id: "gpt-5", name: "GPT-5", config: { id: "gpt-5", name: "GPT-5" } }],
  },
  vercel: {
    id: "vercel", name: "Vercel", npm: "@ai-sdk/openai-compatible", env: ["VERCEL_API_KEY"], doc: null, api: "https://fixture.example/v1",
    config: { id: "vercel", npm: "@ai-sdk/openai-compatible", env: ["VERCEL_API_KEY"], api: "https://fixture.example/v1" },
    models: [{ id: "fixture-model", name: "Fixture Model", config: { id: "fixture-model" } }],
  },
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let cacheModule: typeof import("../src/cache.js")
let shareModule: typeof import("../src/llm/gateway-local-key-share.js")

const ownerUserId = createDenTypeId("user")
const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const foreignOrganizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const teamAlpha = createDenTypeId("team")
const teamBeta = createDenTypeId("team")
const foreignTeam = createDenTypeId("team")
const ownerSessionId = createDenTypeId("session")
const adminSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const staleOwnerSessionId = createDenTypeId("session")
const expiredOwnerSessionId = createDenTypeId("session")
const ownerSessionToken = `lks-owner-${ownerSessionId}`
const adminSessionToken = `lks-admin-${adminSessionId}`
const memberSessionToken = `lks-member-${memberSessionId}`
const staleOwnerSessionToken = `lks-stale-${staleOwnerSessionId}`
const expiredOwnerSessionToken = `lks-expired-${expiredOwnerSessionId}`
let ownerCookie = ""
let adminCookie = ""
let memberCookie = ""
let staleOwnerCookie = ""
let expiredOwnerCookie = ""

const ELIGIBILITY = "/v1/inference-providers/share-local-key/eligibility"
const SHARE = "/v1/inference-providers/share-local-key"

function request(cookie: string | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (cookie) headers.set("cookie", cookie)
  headers.set("origin", API_ORIGIN)
  if (init.body) headers.set("content-type", "application/json")
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }))
}

function share(cookie: string | null, body: unknown, headers: HeadersInit = {}) {
  return request(cookie, SHARE, { method: "POST", body: JSON.stringify(body), headers })
}

function eligibility(cookie: string | null, providerId: string, headers: HeadersInit = {}) {
  return request(cookie, `${ELIGIBILITY}?providerId=${encodeURIComponent(providerId)}`, { headers })
}

function payload(overrides: Partial<{ requestId: string; providerId: string; name: string; secret: string; allMembers: boolean; teamIds: string[] }> = {}): SharePayload {
  const secret = overrides.secret ?? `sk-test-synthetic-${randomUUID()}`
  return {
    requestId: overrides.requestId ?? randomUUID(), providerId: overrides.providerId ?? "anthropic", name: overrides.name ?? "Shared Anthropic key",
    credential: { kind: "api_key", secret }, allMembers: overrides.allMembers ?? true, teamIds: overrides.teamIds ?? [],
  }
}

function providerRows(where = drizzle.eq(schema.GatewayProviderTable.organization_id, organizationId)) {
  return db.select().from(schema.GatewayProviderTable).where(where)
}

function receiptRows(requestId?: string) {
  return db.select().from(schema.GatewayLocalKeyShareTable).where(requestId
    ? drizzle.and(drizzle.eq(schema.GatewayLocalKeyShareTable.organization_id, organizationId), drizzle.eq(schema.GatewayLocalKeyShareTable.request_id, requestId))
    : drizzle.eq(schema.GatewayLocalKeyShareTable.organization_id, organizationId))
}

async function snapshotCounts() {
  return { providers: (await providerRows()).length, receipts: (await receiptRows()).length,
    credentials: (await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.organization_id, organizationId))).length }
}

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({ databaseUrl: process.env.DATABASE_URL, mode: "mysql" }).db
  mock.module("../src/db.js", () => ({ db: realDb }))
  mock.module("../src/llm/models-dev.js", () => ({
    getModelsDevProvider: async (providerId: string) => {
      if (providerId === "anthropic") return catalog.anthropic
      if (providerId === "openai") return catalog.openai
      if (providerId === "vercel") return catalog.vercel
      return null
    },
    listModelsDevProviders: async () => [],
    getModelsDevProviders: async (providerIds: readonly string[]) => Object.values(catalog).filter((provider) => providerIds.includes(provider.id)),
  }))

  const [appModule, dbModule, schemaModule, drizzleModule, cacheImport, shareImport] = await Promise.all([
    import("../src/app.js"), import("../src/db.js"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/den-db/drizzle"),
    import("../src/cache.js"), import("../src/llm/gateway-local-key-share.js"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  cacheModule = cacheImport
  shareModule = shareImport

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Share Owner", email: `share-owner+${ownerUserId}@test.local`, emailVerified: true },
    { id: adminUserId, name: "Share Admin", email: `share-admin+${adminUserId}@test.local`, emailVerified: true },
    { id: memberUserId, name: "Share Member", email: `share-member+${memberUserId}@test.local`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "Key Share Org", slug: `key-share-${organizationId}` },
    { id: foreignOrganizationId, name: "Foreign Org", slug: `foreign-${foreignOrganizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
  ])
  await db.insert(schema.TeamTable).values([
    { id: teamBeta, organizationId, name: "Beta team" },
    { id: teamAlpha, organizationId, name: "Alpha team" },
    { id: foreignTeam, organizationId: foreignOrganizationId, name: "Foreign team" },
  ])
  const now = Date.now()
  await db.insert(schema.AuthSessionTable).values([
    { id: ownerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: ownerSessionToken, expiresAt: new Date(now + 300_000) },
    { id: adminSessionId, userId: adminUserId, activeOrganizationId: organizationId, token: adminSessionToken, expiresAt: new Date(now + 300_000) },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberSessionToken, expiresAt: new Date(now + 300_000) },
    { id: staleOwnerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: staleOwnerSessionToken, expiresAt: new Date(now + 300_000),
      createdAt: new Date(now - FRESH_SESSION_MAX_AGE_MS - 60_000), updatedAt: new Date(now - FRESH_SESSION_MAX_AGE_MS - 60_000) },
    { id: expiredOwnerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: expiredOwnerSessionToken, expiresAt: new Date(now - 60_000) },
  ])

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  ownerCookie = await serializeSignedCookie(SESSION_COOKIE, ownerSessionToken, secret)
  adminCookie = await serializeSignedCookie(SESSION_COOKIE, adminSessionToken, secret)
  memberCookie = await serializeSignedCookie(SESSION_COOKIE, memberSessionToken, secret)
  staleOwnerCookie = await serializeSignedCookie(SESSION_COOKIE, staleOwnerSessionToken, secret)
  expiredOwnerCookie = await serializeSignedCookie(SESSION_COOKIE, expiredOwnerSessionToken, secret)
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }
  const inferenceProviderIds = db.select({ id: schema.GatewayProviderTable.id }).from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.organization_id, organizationId))
  const groups = db.select({ id: schema.GatewayModelGroupTable.id }).from(schema.GatewayModelGroupTable).where(drizzle.inArray(schema.GatewayModelGroupTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayLocalKeyShareTable).where(drizzle.eq(schema.GatewayLocalKeyShareTable.organization_id, organizationId))
  await db.delete(schema.GatewayModelGroupModelTable).where(drizzle.inArray(schema.GatewayModelGroupModelTable.model_group_id, groups))
  await db.delete(schema.GatewayProviderAccessTable).where(drizzle.inArray(schema.GatewayProviderAccessTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderModelTable).where(drizzle.inArray(schema.GatewayProviderModelTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.organization_id, organizationId))
  await db.delete(schema.GatewayModelGroupTable).where(drizzle.inArray(schema.GatewayModelGroupTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayCredentialSetTable).where(drizzle.inArray(schema.GatewayCredentialSetTable.gateway_provider_id, inferenceProviderIds))
  await db.delete(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.organization_id, organizationId))
  await db.delete(schema.AuthApiKeyTable).where(drizzle.inArray(schema.AuthApiKeyTable.referenceId, [ownerUserId, adminUserId, memberUserId]))

  const { cache } = await import("../src/cache.js")
  const tokens = [ownerSessionToken, adminSessionToken, memberSessionToken, staleOwnerSessionToken, expiredOwnerSessionToken]
  await Promise.all(tokens.map((token) => cache.auth.deleteSession(token)))
  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, adminSessionId, memberSessionId, staleOwnerSessionId, expiredOwnerSessionId]))
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.organizationId, [organizationId, foreignOrganizationId]))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, [organizationId, foreignOrganizationId]))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, [organizationId, foreignOrganizationId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, foreignOrganizationId]))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, adminUserId, memberUserId]))
  mock.restore()
})

test("eligibility: fresh owner and admin are eligible with organization-scoped teams only", async () => {
  for (const cookie of [ownerCookie, adminCookie]) {
    const response = await eligibility(cookie, "anthropic")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = readEligibility(await response.json())
    expect(body.eligible).toBe(true)
    expect(body.reason).toBeNull()
    expect(body.organizationId).toBe(organizationId)
    expect(body.organizationName).toBe("Key Share Org")
    expect(body.teams).toEqual([{ id: teamAlpha, name: "Alpha team" }, { id: teamBeta, name: "Beta team" }])
    expect(body.teams.map((team) => team.id)).not.toContain(foreignTeam)
  }
  const ownerBody = readEligibility(await (await eligibility(ownerCookie, "openai")).json())
  expect(ownerBody.memberId).toBe(ownerMemberId)
  const adminBody = readEligibility(await (await eligibility(adminCookie, "openai")).json())
  expect(adminBody.memberId).toBe(adminMemberId)
})

test("eligibility: non-admin member is ineligible with a reason and no teams", async () => {
  const response = await eligibility(memberCookie, "anthropic")
  expect(response.status).toBe(200)
  const body = readEligibility(await response.json())
  expect(body.eligible).toBe(false)
  expect(body.reason).toContain("owners and admins")
  expect(body.teams).toEqual([])
  expect(body.memberId).toBe(memberId)
})

test("eligibility: stale owner session is ineligible until re-verified", async () => {
  const response = await eligibility(staleOwnerCookie, "anthropic")
  expect(response.status).toBe(200)
  const body = readEligibility(await response.json())
  expect(body.eligible).toBe(false)
  expect(body.reason).toContain("fresh owner or admin session")
  expect(body.teams).toEqual([])
})

test("eligibility: unsupported provider is ineligible with the unsupported reason", async () => {
  const response = await eligibility(ownerCookie, "vercel")
  expect(response.status).toBe(200)
  const body = readEligibility(await response.json())
  expect(body.eligible).toBe(false)
  expect(body.reason).toBe(shareModule.LOCAL_KEY_SHARE_UNSUPPORTED)
  expect(body.teams).toEqual([])
  const shareResponse = await share(ownerCookie, payload({ providerId: "vercel" }))
  expect(shareResponse.status).toBe(400)
  expect(readError(await shareResponse.json()).error).toBe("share_provider_unsupported")
})

test("expired session: rejected by the session layer, and re-checked against storage even when the session view is stale", async () => {
  // The session loader excludes expired rows, so a genuinely expired cookie never reaches the route.
  expect((await eligibility(expiredOwnerCookie, "anthropic")).status).toBe(401)

  // Simulate a stale cached session view that still presents the expired session as live.
  const staleLoader = async (token: string): Promise<CachedAuthSession | null> => {
    const [row] = await db.select({ session: schema.AuthSessionTable, user: schema.AuthUserTable }).from(schema.AuthSessionTable)
      .innerJoin(schema.AuthUserTable, drizzle.eq(schema.AuthSessionTable.userId, schema.AuthUserTable.id))
      .where(drizzle.eq(schema.AuthSessionTable.token, token)).limit(1)
    if (!row) return null
    return {
      session: { id: row.session.id, token: row.session.token, userId: row.session.userId, activeOrganizationId: row.session.activeOrganizationId,
        activeTeamId: row.session.activeTeamId, expiresAt: row.session.expiresAt, createdAt: row.session.createdAt, updatedAt: row.session.updatedAt,
        ipAddress: row.session.ipAddress, userAgent: row.session.userAgent },
      user: { id: row.user.id, name: row.user.name, email: row.user.email, emailVerified: row.user.emailVerified, image: row.user.image,
        createdAt: row.user.createdAt, updatedAt: row.user.updatedAt },
    }
  }
  const restore = cacheModule.setCacheDependenciesForTest({ authSessionLoader: staleLoader })
  try {
    const before = await snapshotCounts()
    const eligibilityResponse = await eligibility(expiredOwnerCookie, "anthropic")
    expect(eligibilityResponse.status).toBe(403)
    expect(readError(await eligibilityResponse.json()).error).toBe("share_identity_unverified")
    const shareResponse = await share(expiredOwnerCookie, payload())
    expect(shareResponse.status).toBe(403)
    expect(readError(await shareResponse.json()).error).toBe("share_identity_unverified")
    expect(await snapshotCounts()).toEqual(before)
  } finally {
    restore()
  }

  // The service layer rejects the expired principal directly as well.
  await expect(shareModule.localKeyShareEligibility({ organizationId, memberId: ownerMemberId, userId: ownerUserId, sessionId: expiredOwnerSessionId, sessionToken: expiredOwnerSessionToken }, "anthropic"))
    .rejects.toMatchObject({ status: 403, code: "share_identity_unverified" })
})

test("api-key principal: eligibility and share are refused without writing anything", async () => {
  const { auth } = await import("../src/auth.js")
  const { buildOrganizationApiKeyMetadata } = await import("../src/api-keys.js")
  const apiKey = await auth.api.createApiKey({ body: {
    userId: ownerUserId, name: "Local key share fixture", rateLimitEnabled: false,
    metadata: buildOrganizationApiKeyMetadata({ organizationId, orgMembershipId: ownerMemberId, issuedByUserId: ownerUserId, issuedByOrgMembershipId: ownerMemberId }),
  } })
  const before = await snapshotCounts()
  const eligibilityResponse = await eligibility(null, "anthropic", { "x-api-key": apiKey.key })
  expect(eligibilityResponse.status).toBe(403)
  const shareResponse = await share(null, payload(), { "x-api-key": apiKey.key })
  expect(shareResponse.status).toBe(403)
  expect(await snapshotCounts()).toEqual(before)
})

test("share: one POST atomically stores provider, encrypted credential, default group, organization grant and receipt", async () => {
  const input = payload({ name: "Everyone Anthropic" })
  const secret = input.credential.secret
  const fetchSpy = spyOn(globalThis, "fetch")
  const stdoutSpy = spyOn(process.stdout, "write")
  const stderrSpy = spyOn(process.stderr, "write")
  const consoleSpies = [spyOn(console, "log"), spyOn(console, "info"), spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "debug")]
  let response: Response
  let text: string
  try {
    response = await share(ownerCookie, input)
    text = await response.text()
    expect(fetchSpy.mock.calls.length).toBe(0)
    const emitted = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls, ...consoleSpies.flatMap((spy) => spy.mock.calls)].flatMap((call) => collectStrings(call))
    expect(emitted.some((line) => line.includes(secret))).toBe(false)
  } finally {
    fetchSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    for (const spy of consoleSpies) spy.mockRestore()
  }
  expect(response.status).toBe(200)
  expect(text).not.toContain(secret)
  const receipt = readShare(JSON.parse(text))
  expect(receipt).toEqual({ requestId: input.requestId, organizationId, providerId: "anthropic", inferenceProviderId: receipt.inferenceProviderId })
  expect(receipt.inferenceProviderId.startsWith("ipr_")).toBe(true)

  const providers = await providerRows(drizzle.eq(schema.GatewayProviderTable.id, receipt.inferenceProviderId))
  expect(providers.length).toBe(1)
  const provider = providers[0]
  if (!provider) throw new Error("provider row missing")
  expect(provider).toMatchObject({ organization_id: organizationId, created_by_org_membership_id: ownerMemberId, provider_id: "anthropic", name: "Everyone Anthropic", credential_mode: "org", status: "active", model_ids: [] })
  expect(provider.provider_config).toEqual(catalog.anthropic.config)

  const sets = await db.select().from(schema.GatewayCredentialSetTable).where(drizzle.eq(schema.GatewayCredentialSetTable.gateway_provider_id, provider.id))
  expect(sets.length).toBe(1)
  const set = sets[0]
  if (!set) throw new Error("credential set missing")
  expect(set.credential_mode).toBe("org")

  const credentials = await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, set.id))
  expect(credentials.length).toBe(1)
  const credential = credentials[0]
  if (!credential) throw new Error("credential row missing")
  expect(credential).toMatchObject({ subject: "org", kind: "api_key", organization_id: organizationId, gateway_provider_id: provider.id })
  // Drizzle decrypts on read; the raw column must hold ciphertext, never the plaintext secret.
  expect(credential.secret).toBe(secret)
  const rawResult: unknown = await db.execute(drizzle.sql`select secret from gateway_provider_credentials where id = ${credential.id}`)
  const rawStrings = rawColumnValues(rawResult, "secret")
  expect(rawStrings.length).toBe(1)
  for (const raw of rawStrings) {
    expect(raw).not.toBe(secret)
    expect(raw).not.toContain(secret)
    expect(raw.startsWith("enc:v1:")).toBe(true)
  }
  const allGatewayRows: unknown = await db.execute(drizzle.sql`select secret from gateway_provider_credentials where organization_id = ${organizationId}`)
  expect(collectStrings(allGatewayRows).some((value) => value.includes(secret))).toBe(false)

  const models = await db.select().from(schema.GatewayProviderModelTable).where(drizzle.eq(schema.GatewayProviderModelTable.gateway_provider_id, provider.id))
  expect(models.map((model) => model.model_id).sort()).toEqual(["claude-haiku-4", "claude-sonnet-4"])
  const groups = await db.select().from(schema.GatewayModelGroupTable).where(drizzle.eq(schema.GatewayModelGroupTable.gateway_provider_id, provider.id))
  expect(groups.length).toBe(1)
  const group = groups[0]
  if (!group) throw new Error("model group missing")
  expect(group.name).toBe("All Allowed Models")
  const groupModels = await db.select().from(schema.GatewayModelGroupModelTable).where(drizzle.eq(schema.GatewayModelGroupModelTable.model_group_id, group.id))
  expect(groupModels.length).toBe(2)

  const grants = await db.select().from(schema.GatewayProviderAccessTable).where(drizzle.eq(schema.GatewayProviderAccessTable.gateway_provider_id, provider.id))
  expect(grants.length).toBe(1)
  expect(grants[0]).toMatchObject({ audience_key: "organization", model_group_id: group.id, credential_set_id: set.id, org_membership_id: null, team_id: null })

  const receipts = await receiptRows(input.requestId)
  expect(receipts.length).toBe(1)
  const stored = receipts[0]
  if (!stored) throw new Error("receipt row missing")
  expect(stored).toMatchObject({ organization_id: organizationId, org_membership_id: ownerMemberId, provider_id: "anthropic", gateway_provider_id: provider.id })
  expect(stored.request_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(stored.request_hash).not.toBe(secret)
  expect(stored.request_hash).toBe(shareModule.localKeyShareRequestHash({ organizationId, memberId: ownerMemberId, userId: ownerUserId }, input))
  expect(JSON.stringify(stored)).not.toContain(secret)
})

test("share: team audience creates one grant per chosen team", async () => {
  const input = payload({ name: "Team OpenAI", providerId: "openai", allMembers: false, teamIds: [teamBeta, teamAlpha, teamAlpha] })
  const response = await share(ownerCookie, input)
  expect(response.status).toBe(200)
  const receipt = readShare(await response.json())
  expect(receipt.providerId).toBe("openai")
  const grants = await db.select().from(schema.GatewayProviderAccessTable).where(drizzle.eq(schema.GatewayProviderAccessTable.gateway_provider_id, receipt.inferenceProviderId))
  expect(grants.map((grant) => grant.team_id).sort()).toEqual([teamAlpha, teamBeta].sort())
  expect(grants.every((grant) => grant.audience_key === `team:${grant.team_id}`)).toBe(true)
  const [provider] = await providerRows(drizzle.eq(schema.GatewayProviderTable.id, receipt.inferenceProviderId))
  expect(provider?.provider_id).toBe("openai")
  expect(provider?.provider_config).toEqual(catalog.openai.config)
})

test("idempotency: identical retry returns the same receipt; changed contents conflict; other members are scoped separately", async () => {
  const input = payload({ name: "Idempotent share" })
  const first = readShare(await (await share(ownerCookie, input)).json())
  const before = await snapshotCounts()

  const retry = await share(ownerCookie, input)
  expect(retry.status).toBe(200)
  expect(readShare(await retry.json())).toEqual(first)
  expect(await snapshotCounts()).toEqual(before)

  const variants: SharePayload[] = [
    { ...input, name: "Renamed share" },
    { ...input, credential: { kind: "api_key", secret: `${input.credential.secret}-changed` } },
    { ...input, allMembers: false, teamIds: [teamAlpha] },
    { ...input, providerId: "openai" },
  ]
  for (const variant of variants) {
    const conflict = await share(ownerCookie, variant)
    expect(conflict.status).toBe(409)
    expect(readError(await conflict.json()).error).toBe("share_request_conflict")
    expect(await snapshotCounts()).toEqual(before)
  }

  const adminShare = await share(adminCookie, input)
  expect(adminShare.status).toBe(200)
  const adminReceipt = readShare(await adminShare.json())
  expect(adminReceipt.requestId).toBe(input.requestId)
  expect(adminReceipt.inferenceProviderId).not.toBe(first.inferenceProviderId)
  const receipts = await receiptRows(input.requestId)
  expect(receipts.map((row) => row.org_membership_id).sort()).toEqual([ownerMemberId, adminMemberId].sort())
  expect(await snapshotCounts()).toEqual({ providers: before.providers + 1, receipts: before.receipts + 1, credentials: before.credentials + 1 })
})

test("foreign team: audience outside the organization is refused and nothing is written", async () => {
  const before = await snapshotCounts()
  const input = payload({ allMembers: false, teamIds: [teamAlpha, foreignTeam] })
  const response = await share(ownerCookie, input)
  expect(response.status).toBe(400)
  expect(readError(await response.json()).error).toBe("share_audience_changed")
  expect(await snapshotCounts()).toEqual(before)
  expect((await receiptRows(input.requestId)).length).toBe(0)
})

test("concurrency: parallel identical requests converge on one provider and one receipt", async () => {
  const input = payload({ name: "Concurrent share" })
  const before = await snapshotCounts()
  const responses = await Promise.all(Array.from({ length: 5 }, () => share(ownerCookie, input)))
  const receipts = await Promise.all(responses.map(async (response) => {
    expect(response.status).toBe(200)
    return readShare(await response.json())
  }))
  const ids = new Set(receipts.map((receipt) => receipt.inferenceProviderId))
  expect(ids.size).toBe(1)
  const [inferenceProviderId] = ids
  if (!inferenceProviderId) throw new Error("no inferenceProviderId returned")
  expect((await providerRows(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId))).length).toBe(1)
  expect((await receiptRows(input.requestId)).length).toBe(1)
  expect(await snapshotCounts()).toEqual({ providers: before.providers + 1, receipts: before.receipts + 1, credentials: before.credentials + 1 })
})

test("uncertain response: a retry after a lost response returns the committed receipt", async () => {
  const input = payload({ name: "Lost response share" })
  const before = await snapshotCounts()
  const lost = await share(ownerCookie, input)
  expect(lost.status).toBe(200)
  // Response discarded; the client only knows the transfer id and retries with identical contents.
  const retry = await share(ownerCookie, input)
  expect(retry.status).toBe(200)
  const receipt = readShare(await retry.json())
  const [stored] = await receiptRows(input.requestId)
  expect(stored?.gateway_provider_id).toBe(receipt.inferenceProviderId)
  expect(await snapshotCounts()).toEqual({ providers: before.providers + 1, receipts: before.receipts + 1, credentials: before.credentials + 1 })
})

test("route validation: malformed bodies are rejected before any write", async () => {
  const before = await snapshotCounts()
  const { requestId: _omitted, ...missingRequestId } = payload()
  const bodies: unknown[] = [
    missingRequestId,
    payload({ allMembers: true, teamIds: [teamAlpha] }),
    payload({ allMembers: false, teamIds: [] }),
    { ...payload(), credential: { kind: "api_key", secret: "   " } },
    { ...payload(), requestId: "not-a-uuid" },
    { ...payload(), extra: true },
  ]
  for (const body of bodies) {
    const response = await share(ownerCookie, body)
    expect(response.status).toBe(400)
    expect(readError(await response.json()).error).toBe("invalid_share")
  }
  const memberResponse = await share(memberCookie, payload())
  expect(memberResponse.status).toBe(403)
  expect(readError(await memberResponse.json()).error).toBe("share_not_allowed")
  const staleResponse = await share(staleOwnerCookie, payload())
  expect(staleResponse.status).toBe(403)
  expect(readError(await staleResponse.json()).error).toBe("share_not_allowed")
  expect((await request(null, SHARE, { method: "POST", body: JSON.stringify(payload()) })).status).toBe(401)
  expect(await snapshotCounts()).toEqual(before)
})
