import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"
import { freeInferenceWindow, INFERENCE_ACCESS_REASONS, INFERENCE_FREE_MODEL_ID } from "@openwork/types/den/inference"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_model_team_inheritance"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "z".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
  process.env.DEN_ORG_MODE = "multi_org"
  process.env.INFERENCE_FREE_ENABLED = "false"
  process.env.STRIPE_SECRET_KEY = ""
  process.env.OPENROUTER_MANAGEMENT_API_KEY = ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerId(payload: unknown) {
  if (
    !isRecord(payload)
    || !isRecord(payload.llmProvider)
    || typeof payload.llmProvider.id !== "string"
  ) {
    throw new Error("LLM provider response did not include an id")
  }

  return payload.llmProvider.id
}

function providerIds(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    throw new Error("LLM provider response did not include llmProviders")
  }

  return payload.llmProviders.flatMap((provider) =>
    isRecord(provider) && typeof provider.id === "string" ? [provider.id] : [],
  )
}

function resourceProviderIds(payload: unknown) {
  if (
    !isRecord(payload)
    || !isRecord(payload.resources)
    || !isRecord(payload.resources.llmProviders)
  ) {
    throw new Error("Resource snapshot did not include LLM providers")
  }

  return Object.keys(payload.resources.llmProviders)
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let inference: typeof import("../src/inference.js")
let env: typeof import("../src/env.js").env
let fetchWitness: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

const ownerUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const secondOrganizationId = createDenTypeId("organization")
const secondMemberId = createDenTypeId("member")
const ownedOrganizationIds = [organizationId, secondOrganizationId]
const ownerSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const ownerSessionToken = `provider-parity-owner-${ownerSessionId}`
const memberSessionToken = `provider-parity-member-${memberSessionId}`
let ownerCookie = ""
let memberCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  fetchWitness = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    throw new Error("External requests are forbidden in provider access tests")
  }, { preconnect: globalThis.fetch.preconnect }))

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

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
  inference = await import("../src/inference.js")
  env = (await import("../src/env.js")).env

  await db.insert(schema.AuthUserTable).values([
    {
      id: ownerUserId,
      name: "Provider Parity Owner",
      email: `provider-parity-owner+${ownerUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: memberUserId,
      name: "Invited Provider Parity Member",
      email: `provider-parity-member+${memberUserId}@test.local`,
      emailVerified: true,
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Provider Access Parity",
    slug: `provider-access-parity-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    {
      id: ownerMemberId,
      organizationId,
      userId: ownerUserId,
      role: "owner",
    },
    {
      id: memberId,
      organizationId,
      userId: memberUserId,
      role: "member",
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: secondOrganizationId, name: "Second Allowance Workspace", slug: `allowance-second-${secondOrganizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: secondMemberId, organizationId: secondOrganizationId, userId: memberUserId, role: "member",
  })
  await db.insert(schema.AuthSessionTable).values([
    {
      id: ownerSessionId,
      userId: ownerUserId,
      activeOrganizationId: organizationId,
      token: ownerSessionToken,
      expiresAt: new Date(Date.now() + 300_000),
    },
    {
      id: memberSessionId,
      userId: memberUserId,
      activeOrganizationId: organizationId,
      token: memberSessionToken,
      expiresAt: new Date(Date.now() + 300_000),
    },
  ])

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  ownerCookie = await serializeSignedCookie("openwork-den.session_token", ownerSessionToken, betterAuthSecret)
  memberCookie = await serializeSignedCookie("openwork-den.session_token", memberSessionToken, betterAuthSecret)
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }

  await db.delete(schema.LlmProviderAccessTable).where(
    drizzle.inArray(
      schema.LlmProviderAccessTable.llmProviderId,
      db
        .select({ id: schema.LlmProviderTable.id })
        .from(schema.LlmProviderTable)
        .where(drizzle.inArray(schema.LlmProviderTable.organizationId, ownedOrganizationIds)),
    ),
  )
  await db.delete(schema.LlmProviderModelTable).where(
    drizzle.inArray(
      schema.LlmProviderModelTable.llmProviderId,
      db
        .select({ id: schema.LlmProviderTable.id })
        .from(schema.LlmProviderTable)
        .where(drizzle.inArray(schema.LlmProviderTable.organizationId, ownedOrganizationIds)),
    ),
  )
  await db.delete(schema.LlmProviderTable).where(drizzle.inArray(schema.LlmProviderTable.organizationId, ownedOrganizationIds))
  await db.delete(schema.InferenceKeyTable).where(drizzle.inArray(schema.InferenceKeyTable.organization_id, ownedOrganizationIds))
  await db.delete(schema.InferenceFreeUsageBucketTable).where(drizzle.inArray(schema.InferenceFreeUsageBucketTable.user_id, [ownerUserId, memberUserId]))
  await db.delete(schema.OrgSubscriptionTable).where(drizzle.inArray(schema.OrgSubscriptionTable.organization_id, ownedOrganizationIds))
  await db.delete(schema.AuthSessionTable).where(
    drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, memberSessionId]),
  )
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, ownedOrganizationIds))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.organizationId, ownedOrganizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, ownedOrganizationIds))
  await db.delete(schema.AuthUserTable).where(
    drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberUserId]),
  )
  mock.restore()
})

function request(cookie: string, path: string, init: RequestInit = {}, orgId = organizationId) {
  const headers = new Headers(init.headers)
  headers.set("cookie", cookie)
  headers.set("origin", API_ORIGIN)
  headers.set("x-openwork-org-id", orgId)
  if (init.body) headers.set("content-type", "application/json")
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }))
}

test("org-wide provider grants have list, connect, and resource snapshot parity", async () => {
  const createResponse = await app.fetch(new Request(`${API_ORIGIN}/v1/llm-providers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: ownerCookie,
      origin: API_ORIGIN,
    },
    body: JSON.stringify({
      name: "Shared OpenRouter",
      source: "custom",
      customConfig: {
        id: "shared-openrouter",
        name: "Shared OpenRouter",
        npm: "@ai-sdk/openai-compatible",
        env: ["OPENROUTER_API_KEY"],
        models: [{ id: "openrouter-model", name: "OpenRouter Model" }],
      },
      allMembers: true,
    }),
  }))
  const createPayload: unknown = await createResponse.json()
  expect(createResponse.status).toBe(201)
  const llmProviderId = providerId(createPayload)

  const listResponse = await app.fetch(new Request(`${API_ORIGIN}/v1/llm-providers`, {
    headers: { cookie: memberCookie, origin: API_ORIGIN },
  }))
  const listPayload: unknown = await listResponse.json()
  expect(listResponse.status).toBe(200)
  expect(providerIds(listPayload)).toContain(llmProviderId)

  const connectResponse = await app.fetch(new Request(
    `${API_ORIGIN}/v1/llm-providers/${llmProviderId}/connect`,
    { headers: { cookie: memberCookie, origin: API_ORIGIN } },
  ))
  expect(connectResponse.status).toBe(200)
  await expect(connectResponse.json()).resolves.toMatchObject({
    llmProvider: { id: llmProviderId },
  })

  const resourcesResponse = await app.fetch(new Request(`${API_ORIGIN}/v1/resources`, {
    headers: { cookie: memberCookie, origin: API_ORIGIN },
  }))
  const resourcesPayload: unknown = await resourcesResponse.json()
  expect(resourcesResponse.status).toBe(200)
  expect(resourceProviderIds(resourcesPayload)).toContain(llmProviderId)
})

test("joined members enroll once and read a person-wide allowance without paid provisioning", async () => {
  const { and, eq } = drizzle
  const accessPath = "/v1/inference/access"
  const disabled = await request(memberCookie, accessPath)
  expect(disabled.status).toBe(200)
  expect(await disabled.json()).toMatchObject({ access: { kind: "unavailable", canUpgrade: false }, upgradePath: null })
  expect(await db.select().from(schema.InferenceKeyTable).where(eq(schema.InferenceKeyTable.organization_id, organizationId))).toHaveLength(0)
  expect((await request("", accessPath)).status).toBe(401)
  expect((await request(memberCookie, "/v1/inference")).status).toBe(403)

  env.inferenceFree.enabled = true
  fetchWitness.mockClear()
  await inference.syncInferenceAfterMemberChange({ organizationId: secondOrganizationId, memberId: secondMemberId, memberCount: 1, change: "added" })
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(memberCookie, "/v1/llm-providers")))
  for (const response of responses) expect(response.status).toBe(200)
  const providerWhere = and(eq(schema.LlmProviderTable.organizationId, organizationId), eq(schema.LlmProviderTable.createdByOrgMembershipId, memberId), eq(schema.LlmProviderTable.source, "openwork"))
  const providers = await db.select().from(schema.LlmProviderTable).where(providerWhere)
  expect(providers).toHaveLength(1)
  const provider = providers[0]
  if (!provider) throw new Error("Missing free provider")
  expect(provider.providerId).toBe("openwork")
  const activeKeys = () => db.select().from(schema.InferenceKeyTable).where(and(eq(schema.InferenceKeyTable.org_membership_id, memberId), eq(schema.InferenceKeyTable.status, "active")))
  expect(await activeKeys()).toHaveLength(1)
  expect(await db.select().from(schema.LlmProviderAccessTable).where(eq(schema.LlmProviderAccessTable.llmProviderId, provider.id))).toHaveLength(1)
  const [org] = await db.select().from(schema.OrganizationTable).where(eq(schema.OrganizationTable.id, organizationId))
  expect(org?.metadata?.inferenceFree).toEqual({ offerAllowed: true })
  expect(org?.metadata?.inference).toBeUndefined()
  for (const table of [schema.InferenceOrgLimitPolicyTable, schema.InferenceOrgUsageBucketTable, schema.InferenceOrgUpstreamProviderKeyTable, schema.OrgSubscriptionTable]) {
    expect(await db.select().from(table).where(eq(table.organization_id, organizationId))).toHaveLength(0)
  }

  const access = await request(memberCookie, `${accessPath}?userId=${ownerUserId}`)
  expect(access.headers.get("cache-control")).toBe("no-store")
  const accessText = await access.text()
  expect(JSON.parse(accessText)).toEqual({
    access: { kind: "free", modelID: INFERENCE_FREE_MODEL_ID, weeklyLimitUsd: 1, usedUsd: 0, reservedUsd: 0, remainingUsd: 1, resetsAt: freeInferenceWindow().end.toISOString(), reason: null, canUpgrade: false },
    upgradePath: null,
  })
  expect(accessText).not.toContain(provider.apiKey)
  expect(accessText).not.toContain("key_hash")
  expect(accessText).not.toContain("upstreamProviderConfigured")
  expect(await (await request(ownerCookie, accessPath)).json()).toMatchObject({ access: { canUpgrade: true }, upgradePath: "/dashboard/billing" })

  const connectPath = `/v1/llm-providers/${provider.id}/connect`
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: provider.apiKey, source: "openwork" } })
  expect((await request(ownerCookie, connectPath)).status).toBe(403)
  const window = freeInferenceWindow()
  await db.insert(schema.InferenceFreeUsageBucketTable).values({
    user_id: memberUserId, window_start_at: window.start, window_end_at: window.end,
    limit_amount: 100_000_000, used_amount: 25_000_000, reserved_amount: 10_000_000,
  })
  for (const orgId of [organizationId, secondOrganizationId]) {
    expect(await (await request(memberCookie, accessPath, {}, orgId)).json()).toMatchObject({
      access: { kind: "free", reason: "free_request_in_progress", usedUsd: 0.25, reservedUsd: 0.1, remainingUsd: 0.75 },
    })
  }
  expect(providerIds(await (await request(memberCookie, "/v1/llm-providers")).json())).toContain(provider.id)
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: provider.apiKey } })
  const { materializeCloudWorkerProviders } = await import("../src/llm/cloud-provider-materialization.js")
  const workerReads: string[] = []
  const sharedWorker = await materializeCloudWorkerProviders({
    organizationId: secondOrganizationId, workerId: createDenTypeId("worker"), instanceUrl: "https://worker.example.test",
    hostToken: "test-host", clientToken: "test-client",
    fetchImpl: async (url, init) => {
      workerReads.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`)
      if (workerReads.at(-1) !== "GET /opencode/config") throw new Error("Must not write a person's free key into a shared worker")
      return Response.json({ provider: {} })
    },
  })
  expect(sharedWorker).toMatchObject({ ok: true, providers: 0 })
  expect(workerReads).toEqual(["GET /opencode/config"])
  expect(await (await request(ownerCookie, accessPath)).json()).toMatchObject({ access: { usedUsd: 0, reservedUsd: 0, remainingUsd: 1 } })
  await db.update(schema.InferenceFreeUsageBucketTable).set({ used_amount: 101_000_000, reserved_amount: 0 }).where(eq(schema.InferenceFreeUsageBucketTable.user_id, memberUserId))
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "exhausted", reason: "free_allowance_exhausted", usedUsd: 1.01, reservedUsd: 0, remainingUsd: 0 } })
  await db.update(schema.InferenceFreeUsageBucketTable).set({ blocked: true }).where(eq(schema.InferenceFreeUsageBucketTable.user_id, memberUserId))
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "unavailable", reason: "accounting_unavailable" } })
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: null } })
  await db.delete(schema.InferenceFreeUsageBucketTable).where(eq(schema.InferenceFreeUsageBucketTable.user_id, memberUserId))

  const modelId = createDenTypeId("llmProviderModel")
  const customConfig = { ...provider.providerConfig, name: "Keep my managed settings" }
  await db.update(schema.LlmProviderTable).set({ providerConfig: customConfig }).where(eq(schema.LlmProviderTable.id, provider.id))
  await db.insert(schema.LlmProviderModelTable).values({ id: modelId, llmProviderId: provider.id, modelId: INFERENCE_FREE_MODEL_ID, name: "Keep Luna", modelConfig: { id: INFERENCE_FREE_MODEL_ID } })
  await db.update(schema.InferenceKeyTable).set({ status: "revoked" }).where(eq(schema.InferenceKeyTable.org_membership_id, memberId))
  await Promise.all(Array.from({ length: 4 }, () => request(memberCookie, connectPath)))
  const [repaired] = await db.select().from(schema.LlmProviderTable).where(providerWhere)
  expect(repaired?.id).toBe(provider.id)
  expect(repaired?.apiKey).not.toBe(provider.apiKey)
  expect(repaired?.providerConfig).toEqual(customConfig)
  expect(await db.select().from(schema.LlmProviderModelTable).where(eq(schema.LlmProviderModelTable.id, modelId))).toHaveLength(1)
  expect(await activeKeys()).toHaveLength(1)
  expect(fetchWitness).not.toHaveBeenCalled()
})

test("rollout, paid precedence, billing fallback and explicit admin disable preserve boundaries", async () => {
  const { and, eq } = drizzle
  const byokBefore = await db.select().from(schema.LlmProviderTable).where(and(eq(schema.LlmProviderTable.organizationId, organizationId), eq(schema.LlmProviderTable.source, "custom")))
  const memberProviders = await db.select().from(schema.LlmProviderTable).where(and(eq(schema.LlmProviderTable.organizationId, organizationId), eq(schema.LlmProviderTable.createdByOrgMembershipId, memberId), eq(schema.LlmProviderTable.source, "openwork")))
  const provider = memberProviders[0]
  if (!provider) throw new Error("Missing managed provider")
  const connectPath = `/v1/llm-providers/${provider.id}/connect`
  const accessPath = "/v1/inference/access"

  env.inferenceFree.enabled = false
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { reason: "free_disabled" } })
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: null } })
  expect(providerIds(await (await request(memberCookie, "/v1/llm-providers")).json())).not.toContain(provider.id)
  await db.update(schema.OrganizationTable).set({ metadata: { inference: { enabled: true, tier: "tier2" }, inferenceFree: { offerAllowed: true } } }).where(eq(schema.OrganizationTable.id, organizationId))
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "paid", modelID: null, weeklyLimitUsd: null, remainingUsd: null } })
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: provider.apiKey } })
  env.inferenceFree.enabled = true
  await inference.setInferenceEnabled({ organizationId, enabled: false, source: "billing" })
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "free" } })
  const [downgraded] = await db.select().from(schema.LlmProviderTable).where(eq(schema.LlmProviderTable.id, provider.id))
  expect(downgraded?.providerConfig).toEqual(provider.providerConfig)
  expect(await db.select().from(schema.LlmProviderModelTable).where(eq(schema.LlmProviderModelTable.llmProviderId, provider.id))).toHaveLength(1)
  await inference.setInferenceEnabled({ organizationId, enabled: false, source: "billing" })
  expect(await (await request(memberCookie, connectPath)).json()).toMatchObject({ llmProvider: { apiKey: downgraded?.apiKey } })

  const disable = await request(ownerCookie, "/v1/inference", { method: "PATCH", body: JSON.stringify({ enabled: false, inferenceFree: { offerAllowed: true }, source: "billing" }) })
  expect(disable.status).toBe(200)
  await inference.setInferenceEnabled({ organizationId, enabled: false, source: "billing" })
  await inference.setInferenceEnabled({ organizationId, enabled: true, source: "billing" })
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "unavailable", reason: "admin_disabled" } })
  expect(await db.select().from(schema.InferenceKeyTable).where(and(eq(schema.InferenceKeyTable.organization_id, organizationId), eq(schema.InferenceKeyTable.status, "active")))).toHaveLength(0)
  expect((await request(memberCookie, connectPath)).status).toBe(404)
  expect(await db.select().from(schema.LlmProviderTable).where(and(eq(schema.LlmProviderTable.organizationId, organizationId), eq(schema.LlmProviderTable.source, "custom")))).toEqual(byokBefore)
  expect((await request(memberCookie, "/v1/inference", { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(403)

  await db.update(schema.OrganizationTable).set({ metadata: { inference: { enabled: false }, inferenceFree: { offerAllowed: true } } }).where(eq(schema.OrganizationTable.id, organizationId))
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { reason: "admin_disabled" } })
  await db.update(schema.OrganizationTable).set({ metadata: null }).where(eq(schema.OrganizationTable.id, organizationId))
  await db.insert(schema.OrgSubscriptionTable).values({ id: createDenTypeId("orgSubscription"), organization_id: organizationId, type: "inference", status: "canceled", stripe_customer_id: "cus_allowance_test", stripe_subscription_id: `sub_${organizationId}` })
  expect(await (await request(memberCookie, accessPath)).json()).toMatchObject({ access: { kind: "unavailable", reason: "not_eligible" } })
  expect(await db.select().from(schema.InferenceOrgLimitPolicyTable).where(eq(schema.InferenceOrgLimitPolicyTable.organization_id, organizationId))).toHaveLength(0)

  await db.update(schema.MemberTable).set({ joinedAt: null }).where(eq(schema.MemberTable.id, secondMemberId))
  expect((await request(memberCookie, accessPath, {}, secondOrganizationId)).status).toBe(403)
  expect(await inference.repairMemberInferenceAccessIfNeeded({ organizationId: secondOrganizationId, memberId: secondMemberId })).toBe(false)
  await db.update(schema.MemberTable).set({ joinedAt: new Date(), removedAt: new Date() }).where(eq(schema.MemberTable.id, secondMemberId))
  await inference.syncInferenceAfterMemberChange({ organizationId: secondOrganizationId, memberId: secondMemberId, memberCount: 0, change: "removed" })
  expect((await request(memberCookie, accessPath, {}, secondOrganizationId)).status).toBe(404)
  expect(await db.select().from(schema.InferenceKeyTable).where(and(eq(schema.InferenceKeyTable.org_membership_id, secondMemberId), eq(schema.InferenceKeyTable.status, "active")))).toHaveLength(0)
  expect(fetchWitness).not.toHaveBeenCalled()
})

test("raw organization creation cannot spoof free or paid entitlements", async () => {
  const slug = `allowance-spoof-${createDenTypeId("organization")}`
  const response = await request(ownerCookie, "/api/auth/organization/create", {
    method: "POST", body: JSON.stringify({ name: "Allowance Metadata Boundary", slug, metadata: { inference: { enabled: true, tier: "tier2" }, inferenceFree: { offerAllowed: true }, retained: "yes" } }),
  })
  expect(response.status).toBe(200)
  const [created] = await db.select().from(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.slug, slug))
  if (!created) throw new Error("Missing created organization")
  ownedOrganizationIds.push(created.id)
  expect(created.metadata?.inference).toBeUndefined()
  expect(created.metadata?.inferenceFree).toBeUndefined()
  expect(created.metadata?.retained).toBe("yes")
  expect(await (await request(ownerCookie, "/v1/inference/access", {}, created.id)).json()).toMatchObject({ access: { kind: "free" } })
  const [enrolled] = await db.select().from(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, created.id))
  expect(enrolled?.metadata).toMatchObject({ retained: "yes", inferenceFree: { offerAllowed: true } })
  expect(fetchWitness).not.toHaveBeenCalled()
})

test("model catalog retains paid entries for contextual upgrade discovery", async () => {
  fetchWitness.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    if (String(input) !== "https://models.openworklabs.com/api.json") throw new Error("Unexpected external request")
    return Response.json({ openwork: { id: "openwork", name: "OpenWork", models: {
      [INFERENCE_FREE_MODEL_ID]: { id: INFERENCE_FREE_MODEL_ID, name: "Luna" },
      "z-ai/glm-5.2": { id: "z-ai/glm-5.2", name: "Paid model" },
    } } })
  }, { preconnect: globalThis.fetch.preconnect }))
  const response = await request(memberCookie, "/v1/llm-provider-catalog/openwork")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ provider: { models: expect.arrayContaining([
    expect.objectContaining({ id: INFERENCE_FREE_MODEL_ID }), expect.objectContaining({ id: "z-ai/glm-5.2" }),
  ]) } })
  expect(fetchWitness).toHaveBeenCalledTimes(1)
})

test("member access OpenAPI exposes the shared metered reason contract", async () => {
  const response = await request("", "/openapi.json")
  expect(response.status).toBe(200)
  const document: unknown = await response.json()
  expect(document).toHaveProperty(["paths", "/v1/inference/access", "get", "operationId"], "getV1InferenceAccess")
  expect(document).toHaveProperty(["components", "schemas", "InferenceAccessResponse", "properties", "access", "properties", "reason"], {
    anyOf: [{ type: "string", enum: [...INFERENCE_ACCESS_REASONS] }, { type: "null" }],
  })
})
