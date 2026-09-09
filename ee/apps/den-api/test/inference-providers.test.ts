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

function readRows(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${key} was not an object array`)
  return value
}

function firstRow(record: Record<string, unknown>, key: string) {
  const row = readRows(record, key)[0]
  if (!row) throw new Error(`${key} was empty`)
  return row
}

function readResource(value: unknown, key: string) {
  if (!isRecord(value) || !isRecord(value[key])) throw new Error(`${key} missing`)
  return value[key]
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
  azure: {
    id: "azure",
    name: "Azure",
    npm: "@ai-sdk/azure",
    env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
    doc: null,
    api: null,
    config: { id: "azure", name: "Azure", npm: "@ai-sdk/azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
    models: [{ id: "fixture-deployment", name: "Fixture Deployment", config: { id: "fixture-deployment" } }],
  },
  "google-vertex": {
    id: "google-vertex",
    name: "Vertex",
    npm: "@ai-sdk/google-vertex",
    env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
    doc: null,
    api: null,
    config: { id: "google-vertex", npm: "@ai-sdk/google-vertex" },
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", config: { id: "gemini-2.5-pro" } },
      { id: "claude-on-vertex", name: "Claude on Vertex", config: { id: "claude-on-vertex", provider: { npm: "@ai-sdk/google-vertex/anthropic" } } },
    ],
  },
  "google-vertex-anthropic": {
    id: "google-vertex-anthropic", name: "Vertex Anthropic", npm: "@ai-sdk/google-vertex/anthropic",
    env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"], doc: null, api: null,
    config: { id: "google-vertex-anthropic", npm: "@ai-sdk/google-vertex/anthropic" },
    models: [{ id: "claude-on-vertex", name: "Claude on Vertex", config: { id: "claude-on-vertex", provider: { npm: "@ai-sdk/google-vertex/anthropic" } } }],
  },
}

const reviewCatalog = [
  { id: "cloudflare", env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1" },
  { id: "infomaniak", env: ["INFOMANIAK_PRODUCT_ID", "INFOMANIAK_API_TOKEN"], api: "https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1" },
  { id: "azure-cognitive-services", env: ["AZURE_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY", "AZURE_COGNITIVE_SERVICES_API_TOKEN"], api: "https://fixture.example/v1" },
  { id: "alibaba", env: ["DASHSCOPE_API_KEY"], api: "https://fixture.example/v1" },
  { id: "moonshotai", env: ["MOONSHOT_API_KEY"], api: "https://fixture.example/v1" },
  { id: "ambiguous", env: ["FIRST_API_KEY", "SECOND_API_KEY"], api: "https://fixture.example/v1" },
].map((entry) => ({ ...entry, name: entry.id, npm: "@ai-sdk/openai-compatible", doc: null,
  config: { id: entry.id, npm: "@ai-sdk/openai-compatible", env: entry.env, api: entry.api },
  models: [{ id: "fixture-model", name: "Fixture Model", config: { id: "fixture-model", provider: { npm: "@ai-sdk/openai-compatible" }, limit: { output: 1234 } } }],
}))

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
      if (providerId === "azure") return catalog.azure
      if (providerId === "google-vertex") return catalog["google-vertex"]
      if (providerId === "google-vertex-anthropic") return catalog["google-vertex-anthropic"]
      return reviewCatalog.find((provider) => provider.id === providerId) ?? null
    },
    listModelsDevProviders: async () => [],
    getModelsDevProviders: async (providerIds: readonly string[]) => [...Object.values(catalog), ...reviewCatalog].filter((provider) => providerIds.includes(provider.id)),
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
    credentialStatus: "org_credential_missing",
    authUrl: null,
    providerConfig: {
      npm: "@ai-sdk/anthropic",
      env: [`${inferenceProviderId.toUpperCase()}_ANTHROPIC_API_KEY`],
      api: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}`,
      options: { baseURL: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}` },
    },
    models: [],
    modelGroups: [{ name: "All Allowed Models", modelIds: ["claude-sonnet-4"] }],
    accessGrants: [{ audience: { type: "member", memberId } }],
    credentials: [{ subject: "org", kind: "api_key", status: "active", expiresAt: null }],
  })

  // Stored config stays upstream-shaped so the gateway can resolve the real base URL.
  const [storedRow] = await db
    .select({ providerConfig: schema.GatewayProviderTable.provider_config })
    .from(schema.GatewayProviderTable)
    .where(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId))
  expect(storedRow?.providerConfig).toEqual(catalog.anthropic.config)

  const memberList = readProviderList(await (await request(memberCookie, "/v1/inference-providers")).json())
  expect(memberList.map((provider) => provider.id)).toEqual([inferenceProviderId])
  expect(memberList[0]?.access).toBeUndefined()
  expect(memberList[0]?.credentials).toBeUndefined()

  const outsiderList = readProviderList(await (await request(outsiderCookie, "/v1/inference-providers?scope=usable")).json())
  expect(outsiderList).toEqual([])
  expect((await request(memberCookie, "/v1/inference-providers?scope=manageable")).status).toBe(403)
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
  expect(apiKey.startsWith("ow_gw_")).toBe(true)
  const model = firstRow(connect, "models")
  expect(model.id).toMatch(/^gwm_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}$/)
  expect(model).toMatchObject({ upstreamModelId: "claude-sonnet-4", config: { id: model.id } })
  expect((await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).status).toBe(403)
  expect(connect).toMatchObject({
    id: inferenceProviderId,
    source: "openwork_gateway",
    credentialStatus: "ready",
    apiKeys: { [`${inferenceProviderId.toUpperCase()}_ANTHROPIC_API_KEY`]: apiKey },
    providerConfig: {
      npm: "@ai-sdk/anthropic",
      api: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}`,
      options: { baseURL: `${PROXY_BASE_URL}/api/v1/providers/${inferenceProviderId}` },
    },
  })
  expect(connect.access).toBeUndefined()
  expect(connect.credentials).toBeUndefined()

  // Gateway has its own stable key without a Models tier or inference key.
  const activeKeys = await db
    .select({ id: schema.GatewayKeyTable.id })
    .from(schema.GatewayKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.GatewayKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.GatewayKeyTable.status, "active"),
    ))
  expect(activeKeys).toHaveLength(1)
  expect(await db.select().from(schema.InferenceKeyTable).where(drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId))).toEqual([])
  const secondConnect = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(secondConnect.apiKey).toBe(apiKey)
  // A gateway key must not imply an "OpenWork Models" provider in the member's picker.
  expect(await listOpenWorkLlmProviders(memberId)).toEqual([])

  const outsiderConnect = await request(outsiderCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)
  expect(outsiderConnect.status).toBe(403)

  const patchResponse = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Renamed Anthropic" }),
  })
  expect(patchResponse.status).toBe(200)
  const patched = readProvider(await patchResponse.json())
  expect(patched).toMatchObject({
    name: "Renamed Anthropic",
    credentialStatus: "org_credential_missing",
    credentials: [{ subject: "org", kind: "api_key" }],
  })
  const orgGrant = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}/access-grants`, { method: "POST", body: JSON.stringify({ modelGroupId: readString(firstRow(created, "modelGroups"), "id"), credentialSetId: readString(firstRow(created, "credentialSets"), "id"), audience: { type: "organization" } }) })
  expect(orgGrant.status).toBe(201)
  const outsiderAfterPatch = readProviderList(await (await request(outsiderCookie, "/v1/inference-providers")).json())
  expect(outsiderAfterPatch.map((provider) => provider.id)).toEqual([inferenceProviderId])

  const deleteResponse = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, { method: "DELETE" })
  expect(deleteResponse.status).toBe(204)
  const remainingCredentials = await db
    .select({ id: schema.GatewayProviderCredentialTable.id })
    .from(schema.GatewayProviderCredentialTable)
    .where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, inferenceProviderId))
  expect(remainingCredentials).toHaveLength(0)
})

test("all gateway management boundaries deny nonadmin creators, require fresh admin writes, and isolate organizations", async () => {
  const input = { name: "Management boundary", providerId: "anthropic", modelIds: ["claude-sonnet-4"], credential: { kind: "api_key", secret: "fake-boundary-upstream-key" }, memberIds: [memberId] }
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const base = `/v1/inference-providers/${id}`
  const groupId = readString(firstRow(provider, "modelGroups"), "id")
  const setId = readString(firstRow(provider, "credentialSets"), "id")
  const grantId = readString(firstRow(provider, "accessGrants"), "id")
  const legacy = await request(ownerCookie, "/v1/llm-providers", { method: "POST", body: JSON.stringify({ name: "Legacy boundary", source: "models_dev", providerId: "anthropic", modelIds: input.modelIds, apiKey: "fake-legacy-boundary-key" }) })
  expect(legacy.status).toBe(201)
  const sourceId = readString(readResource(await legacy.json(), "llmProvider"), "id")
  // Historical ownership is deliberately retained after the creator loses admin rights.
  await db.update(schema.GatewayProviderTable).set({ created_by_org_membership_id: memberId }).where(drizzle.eq(schema.GatewayProviderTable.id, id))
  await db.update(schema.GatewayCredentialSetTable).set({ created_by_org_membership_id: memberId }).where(drizzle.eq(schema.GatewayCredentialSetTable.id, setId))
  await db.update(schema.LlmProviderTable).set({ createdByOrgMembershipId: memberId }).where(drizzle.eq(schema.LlmProviderTable.id, sourceId))
  const reads = ["/v1/inference-providers?scope=manageable", base, `${base}/models`, `${base}/model-groups`, `${base}/credential-sets`, `${base}/access-grants`, "/v1/inference-providers/usage"]
  const writes: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [
    { path: "/v1/inference-providers", method: "POST", body: input },
    { path: base, method: "PATCH", body: { name: "Denied rename" } },
    { path: base, method: "DELETE" },
    { path: `${base}/model-groups`, method: "POST", body: { name: "Denied group", modelIds: input.modelIds } },
    { path: `${base}/model-groups/${groupId}`, method: "PATCH", body: { name: "Denied group edit" } },
    { path: `${base}/model-groups/${groupId}`, method: "DELETE" },
    { path: `${base}/credential-sets`, method: "POST", body: { name: "Denied shared key", credentialMode: "org", credential: input.credential } },
    { path: `${base}/credential-sets/${setId}`, method: "PATCH", body: { credential: { kind: "api_key", secret: "fake-denied-replacement" } } },
    { path: `${base}/credential-sets/${setId}`, method: "DELETE" },
    { path: `${base}/access-grants`, method: "POST", body: { modelGroupId: groupId, credentialSetId: setId, audience: { type: "organization" } } },
    { path: `${base}/access-grants/${grantId}`, method: "PATCH", body: { audience: { type: "organization" } } },
    { path: `${base}/access-grants/${grantId}`, method: "DELETE" },
    { path: `${base}/access/${grantId}`, method: "DELETE" },
    { path: "/v1/inference-providers/migrate-from-llm-provider", method: "POST", body: { llmProviderId: sourceId } },
  ]
  const snapshot = async () => ({
    provider: await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, id)),
    credentials: await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, id)),
    sets: await db.select().from(schema.GatewayCredentialSetTable).where(drizzle.eq(schema.GatewayCredentialSetTable.gateway_provider_id, id)),
    groups: await db.select().from(schema.GatewayModelGroupTable).where(drizzle.eq(schema.GatewayModelGroupTable.gateway_provider_id, id)),
    grants: await db.select().from(schema.GatewayProviderAccessTable).where(drizzle.eq(schema.GatewayProviderAccessTable.gateway_provider_id, id)),
    source: await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, sourceId)),
  })
  const before = await snapshot()
  const foreignOrg = createDenTypeId("organization")
  const foreignMember = createDenTypeId("member")
  await db.insert(schema.OrganizationTable).values({ id: foreignOrg, name: "Boundary foreign org", slug: foreignOrg })
  await db.insert(schema.MemberTable).values({ id: foreignMember, organizationId: foreignOrg, userId: outsiderUserId, role: "owner" })
  try {
    for (const role of ["member", "provider-manager"]) {
      await db.update(schema.MemberTable).set({ role }).where(drizzle.eq(schema.MemberTable.id, memberId))
      for (const path of reads) expect((await request(memberCookie, path)).status).toBe(403)
      for (const attempt of writes) {
        const response = await request(memberCookie, attempt.path, { method: attempt.method, ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}) })
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ error: "forbidden" })
      }
    }
    expect(await snapshot()).toEqual(before)
    const connected = await request(memberCookie, `${base}/connect`)
    expect(connected.status).toBe(200)
    const usable = readProviderList(await (await request(memberCookie, "/v1/inference-providers?scope=usable")).json()).find((entry) => entry.id === id)
    expect(usable).toBeDefined()
    for (const entry of [usable, readProvider(await connected.json())]) {
      expect(entry?.credentials).toBeUndefined()
      expect(entry?.credentialSets).toBeUndefined()
      expect(entry?.accessGrants).toBeUndefined()
    }
    expect((await request(memberCookie, `${base}/oauth/start?credentialSetId=${setId}`)).status).toBe(403)
    expect((await request(memberCookie, `${base}/oauth?credentialSetId=${setId}`, { method: "DELETE" })).status).toBe(403)
    const foreignHeaders = { "x-openwork-org-id": foreignOrg }
    for (const path of reads.filter((path) => path.startsWith(base))) expect((await request(outsiderCookie, path, { headers: foreignHeaders })).status).toBe(404)
    for (const attempt of writes.filter((attempt) => attempt.path.startsWith(base) || attempt.path.endsWith("migrate-from-llm-provider"))) {
      const response = await request(outsiderCookie, attempt.path, { method: attempt.method, headers: foreignHeaders, ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}) })
      expect(response.status).toBe(attempt.path.endsWith("migrate-from-llm-provider") ? 409 : 404)
    }
    expect((await request(outsiderCookie, `${base}/connect`, { headers: foreignHeaders })).status).toBe(404)
    const foreignList = readProviderList(await (await request(outsiderCookie, "/v1/inference-providers?scope=manageable", { headers: foreignHeaders })).json())
    expect(foreignList).toEqual([])
    expect(await snapshot()).toEqual(before)

    for (const role of ["admin", "super-admin", "owner", "provider-manager,admin"]) {
      await db.update(schema.MemberTable).set({ role }).where(drizzle.eq(schema.MemberTable.id, memberId))
      await db.update(schema.AuthSessionTable).set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
      for (const path of reads) expect((await request(memberCookie, path)).status).toBe(200)
      for (const attempt of writes) {
        const response = await request(memberCookie, attempt.path, { method: attempt.method, ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}) })
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
      }
      await db.update(schema.AuthSessionTable).set({ createdAt: new Date() }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
      expect((await request(memberCookie, base, { method: "PATCH", body: JSON.stringify({ name: `Allowed ${role}` }) })).status).toBe(200)
    }
    expect((await request(memberCookie, `${base}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ name: "Admin edit" }) })).status).toBe(200)
    expect((await request(memberCookie, `${base}/model-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name: "Admin group" }) })).status).toBe(200)
    expect((await request(memberCookie, `${base}/access-grants/${grantId}`, { method: "PATCH", body: JSON.stringify({ audience: { type: "organization" } }) })).status).toBe(200)
    expect((await request(memberCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: sourceId }) })).status).toBe(201)
    expect((await request(memberCookie, `${base}/access-grants/${grantId}`, { method: "DELETE" })).status).toBe(204)
    expect((await request(memberCookie, `${base}/credential-sets/${setId}`, { method: "DELETE" })).status).toBe(204)
    expect((await request(memberCookie, `${base}/model-groups/${groupId}`, { method: "DELETE" })).status).toBe(204)
    expect((await request(memberCookie, base, { method: "DELETE" })).status).toBe(204)
  } finally {
    await db.update(schema.MemberTable).set({ role: "member" }).where(drizzle.eq(schema.MemberTable.id, memberId))
    await db.update(schema.AuthSessionTable).set({ createdAt: new Date() }).where(drizzle.eq(schema.AuthSessionTable.id, memberSessionId))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, foreignMember))
    await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, foreignOrg))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, foreignOrg))
  }
})

test("provider destinations and source snapshots are immutable without stripping credentials; metadata edits remain allowed", async () => {
  for (const fixture of [
    { providerId: "anthropic", modelIds: ["claude-sonnet-4"], settings: { upstreamBaseUrl: "https://original.example/v1", region: "us-east-1" }, changes: [{ upstreamBaseUrl: "https://different.example/v1" }, { upstreamBaseUrl: "https://original.example/another-account/v1" }, { region: "eu-west-1" }] },
    { providerId: "azure", modelIds: ["fixture-deployment"], settings: { resourceName: "original-resource", apiVersion: "2025-04-01-preview" }, changes: [{ resourceName: "other-resource" }, { apiVersion: "2025-01-01-preview" }] },
    { providerId: "google-vertex", modelIds: ["gemini-2.5-pro"], settings: { project: "original-project", location: "us-central1" }, changes: [{ project: "different-project" }, { location: "europe-west1" }] },
  ]) {
    const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Pinned destination", providerId: fixture.providerId, modelIds: fixture.modelIds, settings: fixture.settings, credential: { kind: "api_key", secret: "fake-pinned-destination-key" } }) })
    expect(created.status).toBe(201)
    const id = readString(readProvider(await created.json()), "id")
    const base = `/v1/inference-providers/${id}`
    const load = async () => ({
      providers: await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, id)),
      credentials: await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, id)),
      models: await db.select().from(schema.GatewayProviderModelTable).where(drizzle.eq(schema.GatewayProviderModelTable.gateway_provider_id, id)),
    })
    const before = await load()
    expect(before.credentials).toHaveLength(1)
    for (const settings of fixture.changes) {
      const denied = await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ name: "Must not persist", settings }) })
      expect(denied.status).toBe(409)
      expect(await denied.json()).toMatchObject({ error: "provider_destination_immutable" })
      expect(await load()).toEqual(before)
    }
    const identity = await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ providerId: "moonshotai" }) })
    expect(identity.status).toBe(409)
    expect(await identity.json()).toMatchObject({ error: "provider_identity_immutable" })
    for (const body of [
      { providerConfig: { api: "https://different.example/v1", npm: "@ai-sdk/openai", options: { baseURL: "https://different.example/v1" } } },
      { provider_config: { api: "https://different.example/v1" } },
      { settings: { migration: { llmProviderId: createDenTypeId("llmProvider"), runtimeEnvNames: [] } } },
    ]) expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify(body) })).status).toBe(400)
    expect(await load()).toEqual(before)
    expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ providerId: fixture.providerId, settings: fixture.settings, name: "Same destination" }) })).status).toBe(200)
    expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ settings: {}, name: "Partial settings preserve destination", modelIds: [] }) })).status).toBe(200)
    expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) })).status).toBe(200)
    const after = await load()
    expect(after.providers[0]).toMatchObject({ name: "Partial settings preserve destination", model_ids: [], status: "disabled", settings: before.providers[0]?.settings, provider_config: before.providers[0]?.provider_config })
    expect(after.credentials).toEqual(before.credentials)
  }

  const source = reviewCatalog.find((entry) => entry.id === "moonshotai")
  if (!source) throw new Error("Catalog fixture missing")
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Catalog snapshot", providerId: source.id, modelIds: ["fixture-model"], credential: { kind: "api_key", secret: "fake-snapshot-key" } }) })
  expect(created.status).toBe(201)
  const id = readString(readProvider(await created.json()), "id")
  const loadConfig = async () => (await db.select({ config: schema.GatewayProviderTable.provider_config }).from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, id)))[0]
  const before = await loadConfig()
  const original = { api: source.api, npm: source.npm, config: source.config }
  try {
    source.api = "https://changed-catalog.example/v1"
    source.config = { ...source.config, api: source.api }
    expect((await request(ownerCookie, `/v1/inference-providers/${id}/models`)).status).toBe(200)
    expect((await request(ownerCookie, `/v1/inference-providers/${id}`, { method: "PATCH", body: JSON.stringify({ name: "Rename with new catalog" }) })).status).toBe(200)
    expect(await loadConfig()).toEqual(before)
    source.npm = "@ai-sdk/openai"
    const detail = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${id}`)).json())
    expect(detail.catalogWarning).toContain("SDK changed")
    expect(await loadConfig()).toEqual(before)
  } finally {
    Object.assign(source, original)
  }
})

test("member-credential mode reports member_auth_required until the member holds a credential", async () => {
  const memberAnthropic = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Member Anthropic", providerId: "anthropic", modelIds: ["claude-haiku-4"], credentialMode: "member" }),
  })
  expect(memberAnthropic.status).toBe(400)
  await expect(memberAnthropic.json()).resolves.toMatchObject({ error: "unsupported_credential_mode" })

  const createResponse = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Member Vertex",
      providerId: "google-vertex",
      modelIds: ["gemini-2.5-pro"],
      settings: { project: "test-project", location: "us-central1" },
      credentialMode: "member",
      oauthClientId: "client-id.apps.googleusercontent.com",
      oauthClientSecret: "GOCSPX-secret-must-not-leak",
      allMembers: true,
    }),
  })
  const createText = await createResponse.text()
  expect(createResponse.status).toBe(201)
  expect(createText).not.toContain("GOCSPX-secret-must-not-leak")
  const created = readProvider(JSON.parse(createText))
  const inferenceProviderId = readString(created, "id")
  expect(firstRow(created, "credentialSets")).toMatchObject({ oauthClientId: "client-id.apps.googleusercontent.com", hasOauthClientSecret: true })
  const credentialSetId = readString(firstRow(created, "credentialSets"), "id")

  const memberConnect = readProvider(await (await request(memberCookie, `/v1/inference-providers/${inferenceProviderId}/connect`)).json())
  expect(memberConnect).toMatchObject({ credentialMode: "member", credentialStatus: "member_auth_required" })
  expect(new URL(readString(memberConnect, "authUrl")).searchParams.get("credentialSetId")).toBe(credentialSetId)

  await db.insert(schema.GatewayProviderCredentialTable).values({
    id: createDenTypeId("inferenceProviderCredential"),
    gateway_provider_id: inferenceProviderId,
    credential_set_id: credentialSetId,
    organization_id: organizationId,
    subject: memberId,
    org_membership_id: memberId,
    kind: "oauth_google",
    secret: JSON.stringify({ accessToken: "ya29.member" }),
    status: "active",
  })

  const readyList = readProviderList(await (await request(memberCookie, "/v1/inference-providers")).json())
  expect(readyList.find((provider) => provider.id === inferenceProviderId)).toMatchObject({ credentialStatus: "ready", authUrl: null })
  const ownerList = readProviderList(await (await request(ownerCookie, "/v1/inference-providers")).json())
  expect(ownerList.find((provider) => provider.id === inferenceProviderId)).toMatchObject({ credentialStatus: "member_auth_required" })

  // Manage view names the member behind each credential; the OAuth client secret stays server-side.
  const detailText = await (await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`)).text()
  expect(detailText).not.toContain("GOCSPX-secret-must-not-leak")
  expect(readProvider(JSON.parse(detailText))).toMatchObject({
    credentialSets: [{ hasOauthClientSecret: true }],
    credentials: [{ subject: memberId, orgMembershipId: memberId, memberName: "Gateway Member", memberEmail: `gateway-member+${memberUserId}@test.local`, kind: "oauth_google" }],
  })

  // Flat OAuth writes cannot mutate explicit sets; a name-only edit preserves them.
  const clearSecret = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ oauthClientSecret: "" }),
  })
  expect(clearSecret.status).toBe(409)
  await expect(clearSecret.json()).resolves.toMatchObject({ error: "matrix_write_required" })
  const rename = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Member Vertex 2" }),
  })
  expect(rename.status).toBe(200)
  expect(readProvider(await rename.json())).toMatchObject({ name: "Member Vertex 2", credentialSets: [{ hasOauthClientSecret: true }] })

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
      settings: { project: "test-project", location: "us-central1" },
      credential: { kind: "gcp_service_account", secret: JSON.stringify({ client_email: "sa@p.iam", private_key: "k", token_uri: "https://oauth2.googleapis.com/token" }) },
      memberIds: [ownerMemberId],
    }),
  })
  expect(vertex.status).toBe(201)
  const vertexProvider = readProvider(await vertex.json())
  expect(vertexProvider).toMatchObject({
    credentialStatus: "ready",
    settings: { project: "test-project", location: "us-central1" },
    providerConfig: { npm: "@ai-sdk/google", env: [`${readString(vertexProvider, "id").toUpperCase()}_GOOGLE_GENERATIVE_AI_API_KEY`] },
    credentials: [{ subject: "org", kind: "gcp_service_account" }],
  })
  const vertexConnect = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${readString(vertexProvider, "id")}/connect`)).json())
  const vertexKey = readString(vertexConnect, "apiKey")
  expect(vertexConnect.apiKeys).toEqual({ [`${readString(vertexProvider, "id").toUpperCase()}_GOOGLE_GENERATIVE_AI_API_KEY`]: vertexKey })
})

test("Azure connect returns the source id and resource settings without treating resource names as credentials", async () => {
  const secret = "fake-azure-upstream-secret"
  const result = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Azure Gateway",
      providerId: "azure",
      modelIds: ["fixture-deployment"],
      settings: { resourceName: "fixture-resource", apiVersion: "2025-04-01-preview" },
      credential: { kind: "api_key", secret },
      memberIds: [ownerMemberId],
    }),
  })
  expect(result.status).toBe(201)
  const id = readString(readProvider(await result.json()), "id")
  const response = await request(ownerCookie, `/v1/inference-providers/${id}/connect`)
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).not.toContain(secret)
  const connected = readProvider(JSON.parse(body))
  const key = readString(connected, "apiKey")
  expect(connected.id).toBe(id)
  expect(connected.providerId).toBe("azure")
  expect(connected.providerConfig).toEqual({
    id: "azure", name: "Azure", npm: "@ai-sdk/azure",
    env: [`${id.toUpperCase()}_AZURE_API_KEY`],
    api: `${PROXY_BASE_URL}/api/v1/providers/${id}`,
    options: { baseURL: `${PROXY_BASE_URL}/api/v1/providers/${id}`, resourceName: "fixture-resource", apiVersion: "2025-04-01-preview" },
  })
  expect(connected.apiKeys).toEqual({ [`${id.toUpperCase()}_AZURE_API_KEY`]: key })
  expect(JSON.stringify(connected.apiKeys)).not.toContain("AZURE_RESOURCE_NAME")
})

test("blank multi-env writes are rejected, omitted fields preserve credentials, and supplied values merge", async () => {
  const created = await request(ownerCookie, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Credential merge", providerId: "azure-cognitive-services", modelIds: ["fixture-model"], apiKeys: { AZURE_COGNITIVE_SERVICES_API_KEY: "fake-primary" } }),
  })
  expect(created.status).toBe(201)
  const provider = readProvider(await created.json())
  const id = readString(provider, "id")
  const setId = readString(firstRow(provider, "credentialSets"), "id")
  const load = async () => (await db.select().from(schema.GatewayProviderCredentialTable)
    .where(drizzle.eq(schema.GatewayProviderCredentialTable.credential_set_id, setId)))[0]
  const original = await load()
  const blank = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ apiKeys: { AZURE_COGNITIVE_SERVICES_API_KEY: "" } }) })
  expect(blank.status).toBe(400)
  expect(await blank.json()).toMatchObject({ error: "invalid_credential" })
  expect(await load()).toEqual(original)
  const absent = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed credentials" }) })
  expect(absent.status).toBe(200)
  expect(await load()).toEqual(original)
  const merged = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ apiKeys: { AZURE_COGNITIVE_SERVICES_API_TOKEN: "fake-secondary" } }) })
  expect(merged.status).toBe(200)
  expect(JSON.parse((await load())?.secret ?? "{}")).toEqual({ AZURE_COGNITIVE_SERVICES_API_KEY: "fake-primary", AZURE_COGNITIVE_SERVICES_API_TOKEN: "fake-secondary" })
  const response = await merged.text()
  expect(response).not.toContain("fake-primary")
  expect(response).not.toContain("fake-secondary")
})

test("template providers require a concrete endpoint and failed migration preserves the source and its models", async () => {
  for (const providerId of ["cloudflare", "infomaniak"]) {
    const input = { name: providerId, providerId, modelIds: ["fixture-model"], credential: { kind: "api_key", secret: "fake-key" } }
    const rejected = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: "invalid_settings" })
    const configured = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...input, settings: { upstreamBaseUrl: "https://configured.example/v1" } }) })
    expect(configured.status).toBe(201)
    expect(await configured.text()).not.toContain("${")
    const legacy = await request(ownerCookie, "/v1/llm-providers", { method: "POST", body: JSON.stringify({ ...input, source: "models_dev", apiKey: "fake-key" }) })
    expect(legacy.status).toBe(201)
    const payload = await legacy.json()
    if (!isRecord(payload) || !isRecord(payload.llmProvider)) throw new Error("Missing source")
    const id = readString(payload.llmProvider, "id")
    const before = await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, id))
    const models = await db.select().from(schema.LlmProviderModelTable).where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, id))
    const migrated = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: id }) })
    expect(migrated.status).toBe(400)
    expect(await migrated.json()).toMatchObject({ error: "migration_requires_configuration" })
    expect(await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, id))).toEqual(before)
    expect(await db.select().from(schema.LlmProviderModelTable).where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, id))).toEqual(models)
  }
})

test("create, patch and migration use trusted catalog credential fields, never injected stored env names", async () => {
  for (const [providerId, field] of [["azure-cognitive-services", "AZURE_COGNITIVE_SERVICES_API_KEY"], ["alibaba", "DASHSCOPE_API_KEY"], ["moonshotai", "MOONSHOT_API_KEY"]]) {
    const input = { name: providerId, providerId, modelIds: ["fixture-model"], apiKeys: { [field]: "fake-key" } }
    const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) })
    expect(created.status).toBe(201)
    const provider = readProvider(await created.json())
    const id = readString(provider, "id")
    const setId = readString(firstRow(provider, "credentialSets"), "id")
    const unknown = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ credential: { kind: "api_key_map", secret: JSON.stringify({ ATTACKER_API_KEY: "injected" }) } }) })
    expect(unknown.status).toBe(400)
    await db.update(schema.GatewayProviderTable).set({ provider_config: { npm: "@ai-sdk/openai-compatible", env: ["ATTACKER_API_KEY"] } }).where(drizzle.eq(schema.GatewayProviderTable.id, id))
    const before = await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, id))
    const injected = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ apiKeys: { ATTACKER_API_KEY: "injected" } }) })
    expect(injected.status).toBe(400)
    expect(await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, id))).toEqual(before)
    const valid = await request(ownerCookie, `/v1/inference-providers/${id}/credential-sets/${setId}`, { method: "PATCH", body: JSON.stringify({ apiKeys: { [field]: "updated-key" } }) })
    expect(valid.status).toBe(200)
    const legacy = await request(ownerCookie, "/v1/llm-providers", { method: "POST", body: JSON.stringify({ ...input, source: "models_dev" }) })
    expect(legacy.status).toBe(201)
    const payload = await legacy.json()
    if (!isRecord(payload) || !isRecord(payload.llmProvider)) throw new Error("Missing source")
    const legacyId = readString(payload.llmProvider, "id")
    await db.update(schema.LlmProviderTable).set({ apiKey: JSON.stringify({ ATTACKER_API_KEY: "injected" }) }).where(drizzle.eq(schema.LlmProviderTable.id, legacyId))
    const refused = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: legacyId }) })
    expect(refused.status).toBe(400)
    expect(await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, legacyId))).toHaveLength(1)
    await db.update(schema.LlmProviderTable).set({ apiKey: JSON.stringify({ [field]: "valid-key" }) }).where(drizzle.eq(schema.LlmProviderTable.id, legacyId))
    const migrated = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: legacyId }) })
    expect(migrated.status).toBe(201)
    expect(readProvider(await migrated.json()).models).toMatchObject([{ upstreamModelId: "fixture-model", config: { provider: { npm: "@ai-sdk/openai-compatible" }, limit: { output: 1234 } } }])
  }
  const settingsOnly = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Settings only", providerId: "azure-cognitive-services", modelIds: ["fixture-model"], apiKeys: { AZURE_RESOURCE_NAME: "not-a-key" } }) })
  expect(settingsOnly.status).toBe(400)
  const ambiguous = { name: "Ambiguous map", providerId: "ambiguous", modelIds: ["fixture-model"], apiKeys: { FIRST_API_KEY: "first", SECOND_API_KEY: "second" } }
  expect((await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify(ambiguous) })).status).toBe(400)
  const single = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...ambiguous, apiKeys: { FIRST_API_KEY: "first" } }) })
  expect(single.status).toBe(201)
  const singleProvider = readProvider(await single.json())
  const singleId = readString(singleProvider, "id")
  const singleSetId = readString(firstRow(singleProvider, "credentialSets"), "id")
  const previous = await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, singleId))
  expect((await request(ownerCookie, `/v1/inference-providers/${singleId}/credential-sets/${singleSetId}`, { method: "PATCH", body: JSON.stringify({ apiKeys: { SECOND_API_KEY: "second" } }) })).status).toBe(400)
  expect(await db.select().from(schema.GatewayProviderCredentialTable).where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, singleId))).toEqual(previous)
  const legacy = await request(ownerCookie, "/v1/llm-providers", { method: "POST", body: JSON.stringify({ ...ambiguous, source: "models_dev" }) })
  expect(legacy.status).toBe(201)
  const payload = await legacy.json()
  if (!isRecord(payload) || !isRecord(payload.llmProvider)) throw new Error("Missing source")
  const legacyId = readString(payload.llmProvider, "id")
  expect((await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: legacyId }) })).status).toBe(400)
  expect(await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, legacyId))).toHaveLength(1)
})

test("mixed Vertex SDK models are rejected on create and patch; incompatible migrated metadata is not stripped", async () => {
  const input = { name: "Mixed Vertex", providerId: "google-vertex", modelIds: ["gemini-2.5-pro", "claude-on-vertex"], settings: { project: "test-project", location: "us-central1" } }
  const rejected = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) })
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ error: "unsupported_model_sdk" })
  const separate = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...input, providerId: "google-vertex-anthropic", modelIds: ["claude-on-vertex"] }) })
  expect(separate.status).toBe(201)
  expect(readProvider(await separate.json())).toMatchObject({ providerId: "google-vertex-anthropic", providerConfig: { npm: "@ai-sdk/anthropic" }, models: [], modelGroups: [{ modelIds: ["claude-on-vertex"] }] })
  const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...input, modelIds: ["gemini-2.5-pro"] }) })
  expect(created.status).toBe(201)
  const id = readString(readProvider(await created.json()), "id")
  const patch = await request(ownerCookie, `/v1/inference-providers/${id}`, { method: "PATCH", body: JSON.stringify({ modelIds: input.modelIds }) })
  expect(patch.status).toBe(400)
  const detail = readProvider(await (await request(ownerCookie, `/v1/inference-providers/${id}`)).json())
  expect(detail.modelGroups).toMatchObject([{ modelIds: ["gemini-2.5-pro"] }])
  const legacy = await request(ownerCookie, "/v1/llm-providers", { method: "POST", body: JSON.stringify({ name: "Legacy mixed SDK", source: "models_dev", providerId: "anthropic", modelIds: ["claude-sonnet-4"], apiKey: "fake-key" }) })
  const payload = await legacy.json()
  if (!isRecord(payload) || !isRecord(payload.llmProvider)) throw new Error("Missing source")
  const legacyId = readString(payload.llmProvider, "id")
  await db.update(schema.LlmProviderModelTable).set({ modelConfig: { provider: { npm: "@ai-sdk/openai" } } }).where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, legacyId))
  const before = await db.select().from(schema.LlmProviderModelTable).where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, legacyId))
  const migrated = await request(ownerCookie, "/v1/inference-providers/migrate-from-llm-provider", { method: "POST", body: JSON.stringify({ llmProviderId: legacyId }) })
  expect(migrated.status).toBe(400)
  expect(await migrated.json()).toMatchObject({ error: "migration_requires_configuration" })
  expect(await db.select().from(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.id, legacyId))).toHaveLength(1)
  expect(await db.select().from(schema.LlmProviderModelTable).where(drizzle.eq(schema.LlmProviderModelTable.llmProviderId, legacyId))).toEqual(before)
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
  const [migrationSnapshot] = await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId))
  expect(migrationSnapshot?.settings.migration).toBeDefined()
  const forgedMigration = await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, { method: "PATCH", body: JSON.stringify({ settings: { migration: { llmProviderId: createDenTypeId("llmProvider"), runtimeEnvNames: [] } } }) })
  expect(forgedMigration.status).toBe(400)
  expect((await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId)))[0]).toEqual(migrationSnapshot)
  expect((await request(ownerCookie, `/v1/inference-providers/${inferenceProviderId}`, { method: "PATCH", body: JSON.stringify({ settings: {}, name: "Legacy Anthropic" }) })).status).toBe(200)
  const [unchangedMigration] = await db.select().from(schema.GatewayProviderTable).where(drizzle.eq(schema.GatewayProviderTable.id, inferenceProviderId))
  expect(unchangedMigration?.settings).toEqual(migrationSnapshot?.settings)
  expect(unchangedMigration?.provider_config).toEqual(migrationSnapshot?.provider_config)
  expect(migrated).toMatchObject({
    name: "Legacy Anthropic",
    providerId: "anthropic",
    credentialMode: "org",
    credentialStatus: "ready",
    accessGrants: expect.arrayContaining([{ id: expect.any(String), modelGroupId: expect.any(String), credentialSetId: expect.any(String), audience: { type: "member", memberId } }]),
    credentials: [{ subject: "org", kind: "api_key", status: "active" }],
  })
  expect(readRows(migrated, "models").map((model) => model.upstreamModelId).sort()).toEqual(["claude-haiku-4", "claude-sonnet-4"])

  const [credential] = await db
    .select({ kind: schema.GatewayProviderCredentialTable.kind, secret: schema.GatewayProviderCredentialTable.secret })
    .from(schema.GatewayProviderCredentialTable)
    .where(drizzle.eq(schema.GatewayProviderCredentialTable.gateway_provider_id, inferenceProviderId))
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
  await expect(customMigrate.json()).resolves.toMatchObject({ error: "migration_requires_configuration" })
})

test("Models enable and disable affect only Models keys, never the stable Gateway key", async () => {
  const [beforeKey] = await db
    .select({ id: schema.GatewayKeyTable.id, encryptedKey: schema.GatewayKeyTable.encrypted_key })
    .from(schema.GatewayKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.GatewayKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.GatewayKeyTable.status, "active"),
    ))
  if (!beforeKey?.encryptedKey) throw new Error("expected an active gateway key with encrypted_key")
  expect(beforeKey.encryptedKey.startsWith("ow_gw_")).toBe(true)
  expect(await listOpenWorkLlmProviders(memberId)).toEqual([])

  await db
    .update(schema.OrganizationTable)
    .set({ metadata: { inference: { enabled: true, tier: "tier1" } } })
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  const { syncInferenceForOrganizationMembers, setInferenceEnabled } = await import("../src/inference.js")
  await syncInferenceForOrganizationMembers({ organizationId })

  const activeKeys = await db
    .select({ id: schema.InferenceKeyTable.id })
    .from(schema.InferenceKeyTable)
    .where(drizzle.and(
      drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId),
      drizzle.eq(schema.InferenceKeyTable.status, "active"),
    ))
  expect(activeKeys).toHaveLength(1)
  expect(activeKeys[0]?.id).not.toBe(beforeKey.id)

  const providers = await listOpenWorkLlmProviders(memberId)
  expect(providers).toHaveLength(1)
  expect(providers[0]?.apiKey).toMatch(/^ow_inf_/)
  expect(providers[0]?.apiKey).not.toBe(beforeKey.encryptedKey)
  await setInferenceEnabled({ organizationId, enabled: false })
  const [gatewayKey] = await db.select().from(schema.GatewayKeyTable).where(drizzle.eq(schema.GatewayKeyTable.id, beforeKey.id))
  expect(gatewayKey).toMatchObject({ status: "active", encrypted_key: beforeKey.encryptedKey })
  expect(await db.select().from(schema.InferenceKeyTable).where(drizzle.and(drizzle.eq(schema.InferenceKeyTable.org_membership_id, memberId), drizzle.eq(schema.InferenceKeyTable.status, "active")))).toEqual([])
  expect(await listOpenWorkLlmProviders(memberId)).toEqual([])
})

test("matrix CRUD keeps overlapping groups, explicit equal-priority choices, catalog identity and tenant isolation", async () => {
  const create = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Matrix", providerId: "anthropic", modelIds: ["claude-sonnet-4", "claude-haiku-4"], credential: { kind: "api_key", secret: "fake-matrix-key-one" }, allMembers: true }) })
  expect(create.status).toBe(201)
  const provider = readProvider(await create.json())
  const id = readString(provider, "id")
  const base = `/v1/inference-providers/${id}`
  const groupId = readString(firstRow(provider, "modelGroups"), "id")
  const firstSetId = readString(firstRow(provider, "credentialSets"), "id")
  const makeSet = async (name: string) => {
    const response = await request(ownerCookie, `${base}/credential-sets`, { method: "POST", body: JSON.stringify({ name, credentialMode: "org", credential: { kind: "api_key", secret: `fake-${name}` } }) })
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(`fake-${name}`)
    return readString(readResource(JSON.parse(text), "credentialSet"), "id")
  }
  const secondSetId = await makeSet("Second")
  const thirdSetId = await makeSet("Third")
  const grant = async (modelGroupId: string, credentialSetId: string, audience: Record<string, string>) => request(ownerCookie, `${base}/access-grants`, { method: "POST", body: JSON.stringify({ modelGroupId, credentialSetId, audience }) })
  const secondGrantResponse = await grant(groupId, secondSetId, { type: "member", memberId })
  expect(secondGrantResponse.status).toBe(201)
  const secondGrantId = readString(readResource(await secondGrantResponse.json(), "accessGrant"), "id")
  expect((await grant(groupId, thirdSetId, { type: "member", memberId })).status).toBe(201)
  expect((await grant(groupId, thirdSetId, { type: "member", memberId })).status).toBe(409)

  const group = await request(ownerCookie, `${base}/model-groups`, { method: "POST", body: JSON.stringify({ name: "Overlap", modelIds: ["claude-haiku-4"] }) })
  expect(group.status).toBe(201)
  const overlapId = readString(readResource(await group.json(), "modelGroup"), "id")
  expect((await grant(overlapId, firstSetId, { type: "organization" })).status).toBe(201)
  const connected = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  const choices = readRows(connected, "models")
  expect(choices).toHaveLength(7)
  expect(choices.filter((model) => model.modelGroupId === groupId && model.credentialSetId === firstSetId)).toHaveLength(2)
  expect(choices.filter((model) => model.upstreamModelId === "claude-haiku-4")).toHaveLength(4)
  for (const model of choices) {
    expect(model.name).toBe(catalog.anthropic.models.find((entry) => entry.id === model.upstreamModelId)?.name)
    expect(model.config).toMatchObject({ id: model.id, name: model.name })
    expect(readString(model, "credentialSetName")).toBe(model.credentialSetId === firstSetId ? "Default credentials" : model.credentialSetId === secondSetId ? "Second" : "Third")
    expect(readString(model, "modelGroupName")).toBe(model.modelGroupId === groupId ? "All Allowed Models" : "Overlap")
  }
  const originalModelRows = await db.select().from(schema.GatewayProviderModelTable).where(drizzle.eq(schema.GatewayProviderModelTable.gateway_provider_id, id))
  const teamOne = createDenTypeId("team")
  const teamTwo = createDenTypeId("team")
  await db.insert(schema.TeamTable).values([{ id: teamOne, organizationId, name: "Matrix team one" }, { id: teamTwo, organizationId, name: "Matrix team two" }])
  await db.insert(schema.TeamMemberTable).values([
    { id: createDenTypeId("teamMember"), teamId: teamOne, orgMembershipId: outsiderMemberId },
    { id: createDenTypeId("teamMember"), teamId: teamTwo, orgMembershipId: outsiderMemberId },
    { id: createDenTypeId("teamMember"), teamId: teamOne, orgMembershipId: memberId },
  ])
  try {
    expect((await grant(groupId, secondSetId, { type: "team", teamId: teamOne })).status).toBe(201)
    expect((await grant(groupId, secondSetId, { type: "team", teamId: teamTwo })).status).toBe(201)
    const equivalent = readProvider(await (await request(outsiderCookie, `${base}/connect`)).json())
    expect(readRows(equivalent, "models").filter((model) => model.modelGroupId === groupId)).toHaveLength(4)
    expect(readRows(equivalent, "models").filter((model) => model.modelGroupId === groupId && model.credentialSetId === secondSetId)).toHaveLength(2)
    expect((await grant(groupId, thirdSetId, { type: "team", teamId: teamTwo })).status).toBe(201)
    const ambiguous = readProvider(await (await request(outsiderCookie, `${base}/connect`)).json())
    expect(readRows(ambiguous, "models").filter((model) => model.modelGroupId === groupId)).toHaveLength(6)
    // Equivalent group/set bindings deduplicate; differently selected organization sets remain available.
    const direct = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
    expect(readRows(direct, "models").map((model) => model.id)).toEqual(choices.map((model) => model.id))
    const teamOnlySetId = await makeSet("Team only")
    expect((await grant(groupId, teamOnlySetId, { type: "team", teamId: teamOne })).status).toBe(201)
    const explicitTeamChoice = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
    expect(readRows(explicitTeamChoice, "models").filter((model) => model.modelGroupId === groupId && model.credentialSetId === teamOnlySetId)).toHaveLength(2)
  } finally {
    await db.delete(schema.GatewayProviderAccessTable).where(drizzle.inArray(schema.GatewayProviderAccessTable.team_id, [teamOne, teamTwo]))
    await db.delete(schema.TeamMemberTable).where(drizzle.inArray(schema.TeamMemberTable.teamId, [teamOne, teamTwo]))
    await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.id, [teamOne, teamTwo]))
  }
  const catalogPatch = await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ modelIds: ["claude-haiku-4", "claude-sonnet-4"] }) })
  expect(catalogPatch.status).toBe(200)
  expect((await db.select().from(schema.GatewayProviderModelTable).where(drizzle.eq(schema.GatewayProviderModelTable.gateway_provider_id, id))).map((model) => model.id).sort()).toEqual(originalModelRows.map((model) => model.id).sort())
  expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ modelIds: ["claude-sonnet-4"] }) })).status).toBe(200)
  const restricted = readProvider(await (await request(memberCookie, `${base}/connect`)).json())
  expect(readRows(restricted, "models").map((model) => model.upstreamModelId)).toEqual(["claude-sonnet-4", "claude-sonnet-4", "claude-sonnet-4"])
  expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ modelIds: ["claude-haiku-4", "claude-sonnet-4"] }) })).status).toBe(200)
  expect((await request(ownerCookie, base, { method: "PATCH", body: JSON.stringify({ allMembers: false }) })).status).toBe(409)
  expect((await request(ownerCookie, `${base}/model-groups/${groupId}`, { method: "DELETE" })).status).toBe(409)
  expect((await request(ownerCookie, `${base}/credential-sets/${secondSetId}`, { method: "DELETE" })).status).toBe(409)
  expect((await request(memberCookie, `${base}/model-groups`)).status).toBe(403)
  expect((await request(memberCookie, `${base}/models`)).status).toBe(403)
  expect((await request(ownerCookie, `${base}/model-groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ modelIds: [readString(firstRow(connected, "models"), "id")] }) })).status).toBe(404)

  const foreignOrg = createDenTypeId("organization")
  const foreignMember = createDenTypeId("member")
  await db.insert(schema.OrganizationTable).values({ id: foreignOrg, name: "Other matrix org", slug: foreignOrg })
  await db.insert(schema.MemberTable).values({ id: foreignMember, organizationId: foreignOrg, userId: outsiderUserId, role: "member" })
  try {
    expect((await grant(groupId, firstSetId, { type: "member", memberId: foreignMember })).status).toBe(404)
  } finally {
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.id, foreignMember))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, foreignOrg))
  }
  const otherCreate = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ name: "Other provider", providerId: "anthropic", modelIds: ["claude-haiku-4"], credential: { kind: "api_key", secret: "fake-other-provider-key" } }) })
  expect(otherCreate.status).toBe(201)
  const other = readProvider(await otherCreate.json())
  expect((await grant(readString(firstRow(other, "modelGroups"), "id"), firstSetId, { type: "member", memberId })).status).toBe(404)
  expect((await grant(groupId, readString(firstRow(other, "credentialSets"), "id"), { type: "member", memberId })).status).toBe(404)
  const patchGrant = await request(ownerCookie, `${base}/access-grants/${secondGrantId}`, { method: "PATCH", body: JSON.stringify({ modelGroupId: overlapId }) })
  expect(patchGrant.status).toBe(200)
  expect((await request(ownerCookie, `${base}/access-grants/${secondGrantId}`, { method: "DELETE" })).status).toBe(204)
  expect((await request(ownerCookie, `${base}/credential-sets/${secondSetId}`, { method: "DELETE" })).status).toBe(204)
  expect((await request(ownerCookie, base, { method: "DELETE" })).status).toBe(204)
})

test("Gateway key issuance is atomic, encrypted, and rotates invalid material in the same membership row", async () => {
  const { ensureMemberGatewayKey } = await import("../src/gateway-keys.js")
  const input = { organizationId, memberId: ownerMemberId }
  const values = await Promise.all([ensureMemberGatewayKey(input), ensureMemberGatewayKey(input), ensureMemberGatewayKey(input)])
  expect(new Set(values).size).toBe(1)
  const first = values[0]
  if (!first) throw new Error("key missing")
  expect(first).toMatch(/^ow_gw_/)
  const rows = await db.select().from(schema.GatewayKeyTable).where(drizzle.and(drizzle.eq(schema.GatewayKeyTable.organization_id, organizationId), drizzle.eq(schema.GatewayKeyTable.org_membership_id, ownerMemberId)))
  expect(rows).toHaveLength(1)
  const key = rows[0]
  if (!key) throw new Error("key row missing")
  const [stored] = await db.execute(drizzle.sql`select encrypted_key, key_hash from gateway_keys where id = ${key.id}`)
  expect(JSON.stringify(stored)).not.toContain(first)
  await db.update(schema.GatewayKeyTable).set({ encrypted_key: "ow_inf_not_a_gateway_key" }).where(drizzle.eq(schema.GatewayKeyTable.id, key.id))
  const rotated = await ensureMemberGatewayKey(input)
  expect(rotated).toMatch(/^ow_gw_/)
  expect(rotated).not.toBe(first)
  const [current] = await db.select().from(schema.GatewayKeyTable).where(drizzle.eq(schema.GatewayKeyTable.id, key.id))
  expect(current).toMatchObject({ id: key.id, encrypted_key: rotated, status: "active", revoked_at: null })
})

test("Vertex create and PATCH accept the runtime project and location constraints", async () => {
  const invalidSettings = [
    { project: "abc", location: "us-central1" },
    { project: "12345", location: "global" },
    { project: "1".repeat(21), location: "global" },
    { project: "a".repeat(64), location: "global" },
    { project: "1project", location: "global" },
    { project: "project-", location: "global" },
    { project: "test-project", location: "us-central" },
    { project: "test-project", location: "us-central1-extra" },
    { project: "test-project", location: "US-central1" },
  ]
  for (const [providerId, modelId] of [["google-vertex", "gemini-2.5-pro"], ["google-vertex-anthropic", "claude-on-vertex"]]) {
    const body = { name: "Vertex validation", providerId, modelIds: [modelId] }
    for (const settings of invalidSettings) {
      const rejected = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...body, settings }) })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ error: "invalid_settings" })
    }
    for (const settings of [
      { project: "abcdef", location: "global" },
      { project: "a".repeat(63), location: "us-central1" },
      { project: "123456", location: "europe-west12" },
      { project: "1".repeat(20), location: "global" },
    ]) {
      const created = await request(ownerCookie, "/v1/inference-providers", { method: "POST", body: JSON.stringify({ ...body, settings }) })
      expect(created.status).toBe(201)
      const id = readString(readProvider(await created.json()), "id")
      for (const invalid of invalidSettings) expect((await request(ownerCookie, `/v1/inference-providers/${id}`, { method: "PATCH", body: JSON.stringify({ settings: invalid }) })).status).toBe(400)
      expect(readProvider(await (await request(ownerCookie, `/v1/inference-providers/${id}`)).json()).settings).toEqual(settings)
    }
  }
})

test("explicit group/set grants reduce by specificity within the pair and choose a stable equivalent grant", async () => {
  const { effectiveGatewayGrants } = await import("../src/llm/inference-provider-lifecycle.js")
  const teamId = createDenTypeId("team")
  const otherTeamId = createDenTypeId("team")
  const organizationGrant = { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: createDenTypeId("inferenceProvider"), model_group_id: createDenTypeId("gatewayModelGroup"), credential_set_id: createDenTypeId("gatewayCredentialSet"), org_membership_id: null, team_id: null, audience_key: "organization", created_at: new Date() }
  const directGrant = { ...organizationGrant, id: createDenTypeId("inferenceProviderAccess"), org_membership_id: memberId, audience_key: `member:${memberId}` }
  const teamGrant = { ...organizationGrant, id: createDenTypeId("inferenceProviderAccess"), credential_set_id: createDenTypeId("gatewayCredentialSet"), team_id: teamId, audience_key: `team:${teamId}` }
  const equivalentTeamGrant = { ...teamGrant, id: createDenTypeId("inferenceProviderAccess"), team_id: otherTeamId, audience_key: `team:${otherTeamId}` }
  const foreignMemberGrant = { ...organizationGrant, id: createDenTypeId("inferenceProviderAccess"), org_membership_id: outsiderMemberId, audience_key: `member:${outsiderMemberId}` }
  const grants = [organizationGrant, directGrant, teamGrant, equivalentTeamGrant, foreignMemberGrant]
  const expected = [directGrant.id, ...[teamGrant.id, equivalentTeamGrant.id].sort().slice(0, 1)].sort()
  expect(effectiveGatewayGrants(grants, memberId, [teamId, otherTeamId]).map((grant) => grant.id).sort()).toEqual(expected)
  expect(effectiveGatewayGrants([...grants].reverse(), memberId, [teamId, otherTeamId]).map((grant) => grant.id).sort()).toEqual(expected)
})
