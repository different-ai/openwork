import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"
const PROXY_BASE_URL = "https://inference.example.test"

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

function readProviderList(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.inferenceProviders)) {
    throw new Error("Response did not include inferenceProviders")
  }
  return payload.inferenceProviders.filter(isRecord)
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
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }))
}

const catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    doc: null,
    api: null,
    config: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
    models: [
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", config: { id: "claude-sonnet-4", name: "Claude Sonnet 4" } },
      { id: "claude-haiku-4", name: "Claude Haiku 4", config: { id: "claude-haiku-4", name: "Claude Haiku 4" } },
    ],
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    npm: "@ai-sdk/amazon-bedrock",
    env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    doc: null,
    api: null,
    config: { id: "amazon-bedrock", npm: "@ai-sdk/amazon-bedrock" },
    models: [{ id: "bedrock-model", name: "Bedrock Model", config: { id: "bedrock-model" } }],
  },
  "google-vertex": {
    id: "google-vertex",
    name: "Vertex",
    npm: "@ai-sdk/google-vertex",
    env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
    doc: null,
    api: null,
    config: { id: "google-vertex", npm: "@ai-sdk/google-vertex" },
    models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", config: { id: "gemini-2.5-pro" } }],
  },
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const outsiderUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const outsiderMemberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const outsiderSessionId = createDenTypeId("session")
const ownerSessionToken = `ipr-owner-${ownerSessionId}`
const memberSessionToken = `ipr-member-${memberSessionId}`
const outsiderSessionToken = `ipr-outsider-${outsiderSessionId}`
let ownerCookie = ""
let memberCookie = ""
let outsiderCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))
  mock.module("../src/llm/models-dev.js", () => ({
    getModelsDevProvider: async (providerId: string) => {
      if (providerId === "anthropic") return catalog.anthropic
      if (providerId === "amazon-bedrock") return catalog["amazon-bedrock"]
      if (providerId === "google-vertex") return catalog["google-vertex"]
      return null
    },
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
    { id: ownerUserId, name: "Gateway Owner", email: `gateway-owner+${ownerUserId}@test.local`, emailVerified: true },
    { id: memberUserId, name: "Gateway Member", email: `gateway-member+${memberUserId}@test.local`, emailVerified: true },
    { id: outsiderUserId, name: "Gateway Outsider", email: `gateway-outsider+${outsiderUserId}@test.local`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Inference Providers",
    slug: `inference-providers-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
    { id: outsiderMemberId, organizationId, userId: outsiderUserId, role: "member" },
  ])
  await db.insert(schema.AuthSessionTable).values([
    { id: ownerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: ownerSessionToken, expiresAt: new Date(Date.now() + 300_000) },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberSessionToken, expiresAt: new Date(Date.now() + 300_000) },
    { id: outsiderSessionId, userId: outsiderUserId, activeOrganizationId: organizationId, token: outsiderSessionToken, expiresAt: new Date(Date.now() + 300_000) },
  ])

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  ownerCookie = await serializeSignedCookie("better-auth.session_token", ownerSessionToken, secret)
  memberCookie = await serializeSignedCookie("better-auth.session_token", memberSessionToken, secret)
  outsiderCookie = await serializeSignedCookie("better-auth.session_token", outsiderSessionToken, secret)
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
  await db.delete(schema.InferenceProviderAccessTable).where(drizzle.inArray(schema.InferenceProviderAccessTable.inference_provider_id, inferenceProviderIds))
  await db.delete(schema.InferenceProviderModelTable).where(drizzle.inArray(schema.InferenceProviderModelTable.inference_provider_id, inferenceProviderIds))
  await db.delete(schema.InferenceProviderCredentialTable).where(drizzle.eq(schema.InferenceProviderCredentialTable.organization_id, organizationId))
  await db.delete(schema.InferenceProviderTable).where(drizzle.eq(schema.InferenceProviderTable.organization_id, organizationId))

  const llmProviderIds = db
    .select({ id: schema.LlmProviderTable.id })
    .from(schema.LlmProviderTable)
    .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.LlmProviderAccessTable).where(drizzle.inArray(schema.LlmProviderAccessTable.llmProviderId, llmProviderIds))
  await db.delete(schema.LlmProviderModelTable).where(drizzle.inArray(schema.LlmProviderModelTable.llmProviderId, llmProviderIds))
  await db.delete(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.InferenceKeyTable).where(drizzle.eq(schema.InferenceKeyTable.organization_id, organizationId))
  await db.delete(schema.InferenceOrgUsageBucketTable).where(drizzle.eq(schema.InferenceOrgUsageBucketTable.organization_id, organizationId))
  await db.delete(schema.InferenceOrgLimitPolicyTable).where(drizzle.eq(schema.InferenceOrgLimitPolicyTable.organization_id, organizationId))

  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, memberSessionId, outsiderSessionId]))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberUserId, outsiderUserId]))
  mock.restore()
})

function listOpenWorkLlmProviders(forMemberId: string) {
  return db
    .select({ id: schema.LlmProviderTable.id, apiKey: schema.LlmProviderTable.apiKey })
    .from(schema.LlmProviderTable)
    .where(drizzle.and(
      drizzle.eq(schema.LlmProviderTable.organizationId, organizationId),
      drizzle.eq(schema.LlmProviderTable.createdByOrgMembershipId, forMemberId),
      drizzle.eq(schema.LlmProviderTable.source, "openwork"),
    ))
}

test("org-credential provider: create, scoped lists, connect with member key and gateway URL, no secret leaks", async () => {
  const orgSecret = "sk-ant-org-secret-must-not-leak"
  const createResponse = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Gateway Anthropic",
      providerId: "anthropic",
      modelIds: ["claude-sonnet-4"],
      credential: { kind: "api_key", secret: orgSecret },
      memberIds: [memberId],
    }),
  })
  const createText = await createResponse.text()
  expect(createResponse.status).toBe(201)
  expect(createText).not.toContain(orgSecret)
  const created = readProvider(JSON.parse(createText))
  const inferenceProviderId = readString(created, "id")
  expect(inferenceProviderId.startsWith("ipr_")).toBe(true)
  expect(created).toMatchObject({
    providerId: "anthropic",
    name: "Gateway Anthropic",
    source: "openwork_gateway",
    credentialMode: "org",
    status: "active",
    credentialStatus: "ready",
    authUrl: null,
    providerConfig: {
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      api: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}`,
      options: { baseURL: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}` },
    },
    models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
    access: { allMembers: false, memberIds: expect.arrayContaining([ownerMemberId, memberId]), teamIds: [] },
    credentials: [{ subject: "org", kind: "api_key", status: "active", expiresAt: null }],
  })

  // Stored config stays upstream-shaped so the gateway can resolve the real base URL.
  const [storedRow] = await db
    .select({ providerConfig: schema.InferenceProviderTable.provider_config })
    .from(schema.InferenceProviderTable)
    .where(drizzle.eq(schema.InferenceProviderTable.id, inferenceProviderId))
  expect(storedRow?.providerConfig).toEqual(catalog.anthropic.config)

  const memberList = readProviderList(await (await request(memberCookie, "/v1/inference-providers")).json())
  expect(memberList.map((provider) => provider.id)).toEqual([inferenceProviderId])
  expect(memberList[0]?.access).toBeUndefined()
  expect(memberList[0]?.credentials).toBeUndefined()

  const outsiderList = readProviderList(await (await request(outsiderCookie, "/v1/inference-providers?scope=usable")).json())
  expect(outsiderList).toEqual([])
  const memberManageable = readProviderList(await (await request(memberCookie, "/v1/inference-providers?scope=manageable")).json())
  expect(memberManageable).toEqual([])
  const ownerManageable = readProviderList(await (await request(ownerCookie, "/v1/inference-providers?scope=manageable")).json())
  expect(ownerManageable.map((provider) => provider.id)).toContain(inferenceProviderId)

  const detailResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}`)
  expect(detailResponse.status).toBe(403)

  const connectResponse = await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)
  const connectText = await connectResponse.text()
  expect(connectResponse.status).toBe(200)
  expect(connectText).not.toContain(orgSecret)
  const connect = readProvider(JSON.parse(connectText))
  const apiKey = readString(connect, "apiKey")
  expect(apiKey.startsWith("ow_inf_")).toBe(true)
  expect(connect).toMatchObject({
    id: inferenceProviderId,
    source: "openwork_gateway",
    credentialStatus: "ready",
    apiKeys: { ANTHROPIC_API_KEY: apiKey },
    providerConfig: {
      npm: "@ai-sdk/anthropic",
      api: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}`,
      options: { baseURL: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}` },
    },
  })
  expect(connect.access).toBeUndefined()
  expect(connect.credentials).toBeUndefined()

  // The key was minted even though the org has no OpenWork Models tier (decision #4) and is stable across connects.
  const activeKeys = await db
    .select({ id: schema.InferenceKeyTable.id })
    .from(schema.InferenceKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.InferenceKeyTable.status, "active"),
    ))
  expect(activeKeys).toHaveLength(1)
  const secondConnect = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(secondConnect.apiKey).toBe(apiKey)
  // A gateway key must not imply an "OpenWork Models" provider in the member's picker.
  expect(await listOpenWorkLlmProviders(memberId)).toEqual([])

  const outsiderConnect = await request(outsiderCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)
  expect(outsiderConnect.status).toBe(403)

  const patchResponse = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Renamed Anthropic", allMembers: true }),
  })
  expect(patchResponse.status).toBe(200)
  const patched = readProvider(await patchResponse.json())
  expect(patched).toMatchObject({
    name: "Renamed Anthropic",
    credentialStatus: "ready",
    access: { allMembers: true },
    credentials: [{ subject: "org", kind: "api_key" }],
  })
  const outsiderAfterPatch = readProviderList(await (await request(outsiderCookie, "/v1/inference-providers")).json())
  expect(outsiderAfterPatch.map((provider) => provider.id)).toEqual([inferenceProviderId])

  const deleteResponse = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, { method: "DELETE" })
  expect(deleteResponse.status).toBe(204)
  const remainingCredentials = await db
    .select({ id: schema.InferenceProviderCredentialTable.id })
    .from(schema.InferenceProviderCredentialTable)
    .where(drizzle.eq(schema.InferenceProviderCredentialTable.inference_provider_id, inferenceProviderId))
  expect(remainingCredentials).toHaveLength(0)
})

test("member-credential mode reports member_auth_required until the member holds a credential", async () => {
  const createResponse = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Member Anthropic",
      providerId: "anthropic",
      modelIds: ["claude-haiku-4"],
      credentialMode: "member",
      allMembers: true,
    }),
  })
  expect(createResponse.status).toBe(201)
  const inferenceProviderId = readString(readProvider(await createResponse.json()), "id")

  const memberConnect = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(memberConnect).toMatchObject({ credentialMode: "member", credentialStatus: "member_auth_required", authUrl: null })

  await db.insert(schema.InferenceProviderCredentialTable).values({
    id: createDenTypeId("inferenceProviderCredential"),
    inference_provider_id: inferenceProviderId,
    organization_id: organizationId,
    subject: memberId,
    org_membership_id: memberId,
    kind: "oauth_google",
    secret: JSON.stringify({ accessToken: "ya29.member" }),
    status: "active",
  })

  const readyList = readProviderList(await (await request(memberCookie, "/v1/inference-providers")).json())
  expect(readyList.find((provider) => provider.id === inferenceProviderId)).toMatchObject({ credentialStatus: "ready" })
  const ownerList = readProviderList(await (await request(ownerCookie, "/v1/inference-providers")).json())
  expect(ownerList.find((provider) => provider.id === inferenceProviderId)).toMatchObject({ credentialStatus: "member_auth_required" })

  const orgModeNoCredential = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "No Key", providerId: "anthropic", modelIds: ["claude-haiku-4"] }),
  })
  expect(orgModeNoCredential.status).toBe(201)
  expect(readProvider(await orgModeNoCredential.json())).toMatchObject({ credentialStatus: "org_credential_missing" })
})

test("rejects unsupported SDKs, unknown models, malformed secrets, and missing Vertex settings", async () => {
  const bedrock = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Bedrock", providerId: "amazon-bedrock", modelIds: ["bedrock-model"] }),
  })
  expect(bedrock.status).toBe(400)
  await expect(bedrock.json()).resolves.toMatchObject({ error: "unsupported_provider" })

  const unknownModel = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Anthropic", providerId: "anthropic", modelIds: ["not-a-model"] }),
  })
  expect(unknownModel.status).toBe(404)
  await expect(unknownModel.json()).resolves.toMatchObject({ error: "model_not_found" })

  const badSecret = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Anthropic",
      providerId: "anthropic",
      modelIds: ["claude-haiku-4"],
      credential: { kind: "api_key_map", secret: "not json" },
    }),
  })
  expect(badSecret.status).toBe(400)
  await expect(badSecret.json()).resolves.toMatchObject({ error: "invalid_credential" })

  const wrongEnv = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Anthropic", providerId: "anthropic", modelIds: ["claude-haiku-4"], apiKeys: { OPENAI_API_KEY: "x" } }),
  })
  expect(wrongEnv.status).toBe(400)
  await expect(wrongEnv.json()).resolves.toMatchObject({ error: "invalid_api_keys" })

  const vertexMissingSettings = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Vertex", providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "p" } }),
  })
  expect(vertexMissingSettings.status).toBe(400)
  await expect(vertexMissingSettings.json()).resolves.toMatchObject({ error: "invalid_settings" })

  const vertex = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      settings: { project: "p", location: "us-central1" },
      credential: { kind: "gcp_service_account", secret: JSON.stringify({ client_email: "sa@p.iam", private_key: "k", token_uri: "https://oauth2.googleapis.com/token" }) },
    }),
  })
  expect(vertex.status).toBe(201)
  const vertexProvider = readProvider(await vertex.json())
  expect(vertexProvider).toMatchObject({
    credentialStatus: "ready",
    providerConfig: { npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
    credentials: [{ subject: "org", kind: "gcp_service_account" }],
  })
  const vertexConnect = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${readString(vertexProvider, "id")}/connect`)).json())
  const vertexKey = readString(vertexConnect, "apiKey")
  expect(vertexConnect.apiKeys).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: vertexKey })
})

test("migrate-from-llm-provider moves config, models, access and credential then deletes the llm_provider", async () => {
  const llmSecret = "sk-ant-legacy-device-key"
  const createLlm = await request(ownerCookie, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Legacy Anthropic",
      source: "models_dev",
      providerId: "anthropic",
      modelIds: ["claude-sonnet-4", "claude-haiku-4"],
      apiKey: llmSecret,
      memberIds: [memberId],
    }),
  })
  expect(createLlm.status).toBe(201)
  const createLlmPayload: unknown = await createLlm.json()
  if (!isRecord(createLlmPayload) || !isRecord(createLlmPayload.llmProvider)) throw new Error("llmProvider missing")
  const llmProviderId = readString(createLlmPayload.llmProvider, "id")

  const memberMigrate = await request(memberCookie, "/v1/inference-providers/migrate-from-llm-provider", {
    method: "POST",
    body: JSON.stringify({ llmProviderId }),
  })
  expect(memberMigrate.status).toBe(403)

  const migrate = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", {
    method: "POST",
    body: JSON.stringify({ llmProviderId }),
  })
  const migrateText = await migrate.text()
  expect(migrate.status).toBe(201)
  expect(migrateText).not.toContain(llmSecret)
  const migrated = readProvider(JSON.parse(migrateText))
  const inferenceProviderId = readString(migrated, "id")
  expect(migrated).toMatchObject({
    name: "Legacy Anthropic",
    providerId: "anthropic",
    credentialMode: "org",
    credentialStatus: "ready",
    access: { allMembers: false, memberIds: expect.arrayContaining([ownerMemberId, memberId]), teamIds: [] },
    credentials: [{ subject: "org", kind: "api_key", status: "active" }],
  })
  expect(migrated.models).toEqual([
    { id: "claude-haiku-4", name: "Claude Haiku 4", config: { id: "claude-haiku-4", name: "Claude Haiku 4" } },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", config: { id: "claude-sonnet-4", name: "Claude Sonnet 4" } },
  ])

  const [credential] = await db
    .select({ kind: schema.InferenceProviderCredentialTable.kind, secret: schema.InferenceProviderCredentialTable.secret })
    .from(schema.InferenceProviderCredentialTable)
    .where(drizzle.eq(schema.InferenceProviderCredentialTable.inference_provider_id, inferenceProviderId))
  expect(credential).toEqual({ kind: "api_key", secret: llmSecret })

  const remainingLlm = await db
    .select({ id: schema.LlmProviderTable.id })
    .from(schema.LlmProviderTable)
    .where(drizzle.eq(schema.LlmProviderTable.id, llmProviderId))
  expect(remainingLlm).toHaveLength(0)
  const remainingLlmModels = await db
    .select({ id: schema.LlmProviderModelTable.id })
    .from(schema.LlmProviderModelTable)
    .where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, llmProviderId))
  expect(remainingLlmModels).toHaveLength(0)
  const remainingLlmAccess = await db
    .select({ id: schema.LlmProviderAccessTable.id })
    .from(schema.LlmProviderAccessTable)
    .where(drizzle.eq(schema.LlmProviderAccessTable.llmProviderId, llmProviderId))
  expect(remainingLlmAccess).toHaveLength(0)

  const memberList = readProviderList(await (await request(memberCookie, "/v1/inference-providers")).json())
  expect(memberList.map((provider) => provider.id)).toContain(inferenceProviderId)

  const createCustom = await request(ownerCookie, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Custom Gateway",
      source: "custom",
      customConfig: { id: "custom-gw", name: "Custom", npm: "@ai-sdk/openai-compatible", env: ["CUSTOM_KEY"], api: "https://gw.example.test/v1", models: [{ id: "m", name: "M" }] },
      apiKey: "custom-secret",
    }),
  })
  expect(createCustom.status).toBe(201)
  const customPayload: unknown = await createCustom.json()
  if (!isRecord(customPayload) || !isRecord(customPayload.llmProvider)) throw new Error("llmProvider missing")
  const customMigrate = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", {
    method: "POST",
    body: JSON.stringify({ llmProviderId: readString(customPayload.llmProvider, "id") }),
  })
  expect(customMigrate.status).toBe(400)
  await expect(customMigrate.json()).resolves.toMatchObject({ error: "unsupported_provider" })
})

test("enabling the OpenWork Models tier reuses the member's gateway-minted key for the synthetic provider row", async () => {
  const [beforeKey] = await db
    .select({ id: schema.InferenceKeyTable.id, encryptedKey: schema.InferenceKeyTable.encrypted_key })
    .from(schema.InferenceKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.InferenceKeyTable.status, "active"),
    ))
  if (!beforeKey?.encryptedKey) throw new Error("expected an active gateway key with encrypted_key")
  expect(beforeKey.encryptedKey.startsWith("ow_inf_")).toBe(true)
  expect(await listOpenWorkLlmProviders(memberId)).toEqual([])

  await db
    .update(schema.OrganizationTable)
    .set({ metadata: { inference: { enabled: true, tier: "tier1" } } })
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  const { syncInferenceForOrganizationMembers } = await import("../src/inference.js")
  await syncInferenceForOrganizationMembers({ organizationId })

  const activeKeys = await db
    .select({ id: schema.InferenceKeyTable.id })
    .from(schema.InferenceKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.InferenceKeyTable.status, "active"),
    ))
  expect(activeKeys).toEqual([{ id: beforeKey.id }])

  const providers = await listOpenWorkLlmProviders(memberId)
  expect(providers).toHaveLength(1)
  expect(providers[0]?.apiKey).toBe(beforeKey.encryptedKey)

  await db
    .update(schema.OrganizationTable)
    .set({ metadata: null })
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
})
