import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@micx-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/micx_test_model_team_inheritance"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "z".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
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
let schema: typeof import("@micx-ee/den-db/schema")
let drizzle: typeof import("@micx-ee/den-db/drizzle")

const ownerUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const ownerSessionToken = `provider-parity-owner-${ownerSessionId}`
const memberSessionToken = `provider-parity-member-${memberSessionId}`
let ownerCookie = ""
let memberCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@micx-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appModule, dbModule, schemaModule, drizzleModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@micx-ee/den-db/schema"),
    import("@micx-ee/den-db/drizzle"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

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
  await db.insert(schema.AuthSessionTable).values([
    {
      id: ownerSessionId,
      userId: ownerUserId,
      activeOrganizationId: organizationId,
      token: ownerSessionToken,
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      id: memberSessionId,
      userId: memberUserId,
      activeOrganizationId: organizationId,
      token: memberSessionToken,
      expiresAt: new Date(Date.now() + 60_000),
    },
  ])

  const betterAuthSecret = process.env.BETTER_AUTH_SECRET
  if (!betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is required")
  }
  ownerCookie = await serializeSignedCookie("better-auth.session_token", ownerSessionToken, betterAuthSecret)
  memberCookie = await serializeSignedCookie("better-auth.session_token", memberSessionToken, betterAuthSecret)
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
        .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId)),
    ),
  )
  await db.delete(schema.LlmProviderModelTable).where(
    drizzle.inArray(
      schema.LlmProviderModelTable.llmProviderId,
      db
        .select({ id: schema.LlmProviderTable.id })
        .from(schema.LlmProviderTable)
        .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId)),
    ),
  )
  await db.delete(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(
    drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, memberSessionId]),
  )
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(
    drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberUserId]),
  )
  mock.restore()
})

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
