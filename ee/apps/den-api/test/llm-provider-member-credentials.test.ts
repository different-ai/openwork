import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { serializeSignedCookie } from "better-call"

const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_model_team_inheritance"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "z".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readProviderId(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.llmProvider) || typeof payload.llmProvider.id !== "string") {
    throw new Error("LLM provider response did not include an id")
  }
  return payload.llmProvider.id
}

function readMemberCredentials(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.memberCredentials)) {
    throw new Error("Member credential response did not include memberCredentials")
  }
  return payload.memberCredentials.filter(isRecord)
}

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("cookie", cookie)
  headers.set("origin", API_ORIGIN)
  if (init.body) headers.set("content-type", "application/json")
  return app.fetch(new Request(`${API_ORIGIN}${path}`, { ...init, headers }))
}

const providerConfig = {
  id: "member-bound-openai",
  name: "Member Bound OpenAI",
  npm: "@ai-sdk/openai-compatible",
  env: ["OPENAI_API_KEY"],
  models: [{ id: "member-model", name: "Member Model" }],
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let orgs: typeof import("../src/orgs.js")

const ownerUserId = createDenTypeId("user")
const memberOneUserId = createDenTypeId("user")
const memberTwoUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const ownerMemberId = createDenTypeId("member")
const memberOneId = createDenTypeId("member")
const memberTwoId = createDenTypeId("member")
const ownerSessionId = createDenTypeId("session")
const memberOneSessionId = createDenTypeId("session")
const memberTwoSessionId = createDenTypeId("session")
const ownerSessionToken = `provider-credential-owner-${ownerSessionId}`
const memberOneSessionToken = `provider-credential-one-${memberOneSessionId}`
const memberTwoSessionToken = `provider-credential-two-${memberTwoSessionId}`
let ownerCookie = ""
let memberOneCookie = ""
let memberTwoCookie = ""

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appModule, dbModule, schemaModule, drizzleModule, orgsModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/orgs.js"),
  ])
  app = appModule.default
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  orgs = orgsModule

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Credential Owner", email: `credential-owner+${ownerUserId}@test.local`, emailVerified: true },
    { id: memberOneUserId, name: "Credential Member One", email: `credential-one+${memberOneUserId}@test.local`, emailVerified: true },
    { id: memberTwoUserId, name: "Credential Member Two", email: `credential-two+${memberTwoUserId}@test.local`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Provider Member Credentials",
    slug: `provider-member-credentials-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: memberOneId, organizationId, userId: memberOneUserId, role: "member" },
    { id: memberTwoId, organizationId, userId: memberTwoUserId, role: "member" },
  ])
  await db.insert(schema.AuthSessionTable).values([
    { id: ownerSessionId, userId: ownerUserId, activeOrganizationId: organizationId, token: ownerSessionToken, expiresAt: new Date(Date.now() + 300_000) },
    { id: memberOneSessionId, userId: memberOneUserId, activeOrganizationId: organizationId, token: memberOneSessionToken, expiresAt: new Date(Date.now() + 300_000) },
    { id: memberTwoSessionId, userId: memberTwoUserId, activeOrganizationId: organizationId, token: memberTwoSessionToken, expiresAt: new Date(Date.now() + 300_000) },
  ])

  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  ownerCookie = await serializeSignedCookie("better-auth.session_token", ownerSessionToken, secret)
  memberOneCookie = await serializeSignedCookie("better-auth.session_token", memberOneSessionToken, secret)
  memberTwoCookie = await serializeSignedCookie("better-auth.session_token", memberTwoSessionToken, secret)
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }

  const providerIds = db
    .select({ id: schema.LlmProviderTable.id })
    .from(schema.LlmProviderTable)
    .where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.LlmProviderMemberCredentialTable).where(
    drizzle.inArray(schema.LlmProviderMemberCredentialTable.llmProviderId, providerIds),
  )
  await db.delete(schema.LlmProviderAccessTable).where(
    drizzle.inArray(schema.LlmProviderAccessTable.llmProviderId, providerIds),
  )
  await db.delete(schema.LlmProviderModelTable).where(
    drizzle.inArray(schema.LlmProviderModelTable.llmProviderId, providerIds),
  )
  await db.delete(schema.LlmProviderTable).where(drizzle.eq(schema.LlmProviderTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(
    drizzle.inArray(schema.AuthSessionTable.id, [ownerSessionId, memberOneSessionId, memberTwoSessionId]),
  )
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(
    drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, memberOneUserId, memberTwoUserId]),
  )
  mock.restore()
})

test("per-member provider credentials resolve, redact, block, purge, and clean up", async () => {
  const organizationKey = "sk-organization-must-not-leak"
  const memberOneKey = "sk-member-one"
  const memberTwoKey = "sk-member-two"
  const createResponse = await request(ownerCookie, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Member Bound OpenAI",
      source: "custom",
      customConfig: providerConfig,
      credentialMode: "per_member",
      apiKey: organizationKey,
      allMembers: true,
    }),
  })
  const createPayload: unknown = await createResponse.json()
  expect(createResponse.status).toBe(201)
  const llmProviderId = readProviderId(createPayload)
  expect(createPayload).toMatchObject({ llmProvider: { credentialMode: "per_member" } })

  for (const cookie of [memberOneCookie, memberTwoCookie]) {
    const missingResponse = await request(cookie, `/v1/llm-providers/${llmProviderId}/connect`)
    expect(missingResponse.status).toBe(200)
    await expect(missingResponse.json()).resolves.toMatchObject({
      llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "missing" } },
    })
  }

  const initialListResponse = await request(memberOneCookie, "/v1/llm-providers")
  const initialList: unknown = await initialListResponse.json()
  expect(initialList).toMatchObject({ llmProviders: [{ id: llmProviderId, hasMyCredential: false }] })

  const selfWriteResponse = await request(memberOneCookie, `/v1/llm-providers/${llmProviderId}/my-credential`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: memberOneKey }),
  })
  expect(selfWriteResponse.status).toBe(200)
  await expect(selfWriteResponse.json()).resolves.toMatchObject({ state: "active", version: 1 })

  const memberOneConnect = await request(memberOneCookie, `/v1/llm-providers/${llmProviderId}/connect`)
  const memberOneConnectPayload: unknown = await memberOneConnect.json()
  expect(memberOneConnect.status).toBe(200)
  expect(memberOneConnectPayload).toMatchObject({
    llmProvider: {
      id: llmProviderId,
      credentialMode: "per_member",
      apiKey: memberOneKey,
      apiKeys: null,
      memberCredential: { state: "active" },
    },
  })
  expect(JSON.stringify(memberOneConnectPayload)).not.toContain(organizationKey)
  const memberTwoStillMissing = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/connect`)
  expect(memberTwoStillMissing.status).toBe(200)
  await expect(memberTwoStillMissing.json()).resolves.toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "missing" } },
  })

  const updatedListResponse = await request(memberOneCookie, "/v1/llm-providers")
  await expect(updatedListResponse.json()).resolves.toMatchObject({
    llmProviders: [{ id: llmProviderId, hasMyCredential: true }],
  })

  const adminListResponse = await request(ownerCookie, `/v1/llm-providers/${llmProviderId}/member-credentials`)
  const adminListText = await adminListResponse.text()
  expect(adminListResponse.status).toBe(200)
  expect(adminListText).not.toContain(memberOneKey)
  expect(adminListText).not.toContain(organizationKey)
  const parsedAdminList: unknown = JSON.parse(adminListText)
  const adminList = readMemberCredentials(parsedAdminList)
  expect(adminList.find((entry) => entry.orgMembershipId === memberOneId)).toMatchObject({ state: "active", version: 1 })
  expect(adminList.find((entry) => entry.orgMembershipId === memberTwoId)).toMatchObject({ state: "missing", version: null })

  const adminWriteResponse = await request(
    ownerCookie,
    `/v1/llm-providers/${llmProviderId}/member-credentials/${memberTwoId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        apiKey: memberTwoKey,
        externalPrincipalId: "external-user-two",
        externalCredentialId: "external-key-two",
      }),
    },
  )
  expect(adminWriteResponse.status).toBe(200)
  await expect(adminWriteResponse.json()).resolves.toMatchObject({ state: "active", version: 1 })

  const provisionedListResponse = await request(ownerCookie, `/v1/llm-providers/${llmProviderId}/member-credentials`)
  const provisionedListText = await provisionedListResponse.text()
  expect(provisionedListText).not.toContain(memberOneKey)
  expect(provisionedListText).not.toContain(memberTwoKey)
  const parsedProvisionedList: unknown = JSON.parse(provisionedListText)
  const provisionedList = readMemberCredentials(parsedProvisionedList)
  expect(provisionedList.find((entry) => entry.orgMembershipId === memberTwoId)).toMatchObject({
    state: "active",
    externalPrincipalId: "external-user-two",
    externalCredentialId: "external-key-two",
  })

  const blockResponse = await request(
    ownerCookie,
    `/v1/llm-providers/${llmProviderId}/member-credentials/${memberTwoId}/block`,
    { method: "POST" },
  )
  expect(blockResponse.status).toBe(200)
  await expect(blockResponse.json()).resolves.toMatchObject({ state: "blocked", version: 2 })
  const blockedConnect = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/connect`)
  expect(blockedConnect.status).toBe(200)
  await expect(blockedConnect.json()).resolves.toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "blocked" } },
  })

  // A blocked binding is admin-owned: the member can neither overwrite it
  // back to active nor delete it to re-create a fresh active row.
  const blockedSelfWrite = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/my-credential`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: "sk-member-two-sneaky" }),
  })
  expect(blockedSelfWrite.status).toBe(409)
  await expect(blockedSelfWrite.json()).resolves.toEqual({ error: "credential_blocked" })
  const blockedSelfDelete = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/my-credential`, {
    method: "DELETE",
  })
  expect(blockedSelfDelete.status).toBe(409)
  await expect(blockedSelfDelete.json()).resolves.toEqual({ error: "credential_blocked" })
  const stillBlockedConnect = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/connect`)
  expect(stillBlockedConnect.status).toBe(200)
  await expect(stillBlockedConnect.json()).resolves.toMatchObject({
    llmProvider: { apiKey: null, apiKeys: null, memberCredential: { state: "blocked" } },
  })

  // Admin re-provisioning is the explicit unblock path.
  const adminUnblock = await request(
    ownerCookie,
    `/v1/llm-providers/${llmProviderId}/member-credentials/${memberTwoId}`,
    {
      method: "PUT",
      body: JSON.stringify({ apiKey: "sk-member-two-restored" }),
    },
  )
  expect(adminUnblock.status).toBe(200)
  await expect(adminUnblock.json()).resolves.toMatchObject({ state: "active" })
  const restoredConnect = await request(memberTwoCookie, `/v1/llm-providers/${llmProviderId}/connect`)
  expect(restoredConnect.status).toBe(200)
  await expect(restoredConnect.json()).resolves.toMatchObject({
    llmProvider: { apiKey: "sk-member-two-restored", memberCredential: { state: "active" } },
  })
  const reBlockResponse = await request(
    ownerCookie,
    `/v1/llm-providers/${llmProviderId}/member-credentials/${memberTwoId}/block`,
    { method: "POST" },
  )
  expect(reBlockResponse.status).toBe(200)

  const sharedKey = "sk-shared-regression"
  const sharedCreateResponse = await request(ownerCookie, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Shared Regression Provider",
      source: "custom",
      customConfig: { ...providerConfig, id: "shared-regression", name: "Shared Regression Provider" },
      apiKey: sharedKey,
      allMembers: true,
    }),
  })
  const sharedProviderId = readProviderId(await sharedCreateResponse.json())
  expect(sharedCreateResponse.status).toBe(201)
  const sharedConnect = await request(memberOneCookie, `/v1/llm-providers/${sharedProviderId}/connect`)
  const sharedConnectPayload: unknown = await sharedConnect.json()
  expect(sharedConnectPayload).toMatchObject({
    llmProvider: { id: sharedProviderId, credentialMode: "shared", apiKey: sharedKey, apiKeys: null },
  })
  if (!isRecord(sharedConnectPayload) || !isRecord(sharedConnectPayload.llmProvider)) {
    throw new Error("Shared provider connect response had an invalid shape")
  }
  expect("memberCredential" in sharedConnectPayload.llmProvider).toBe(false)
  const sharedSelfWrite = await request(memberOneCookie, `/v1/llm-providers/${sharedProviderId}/my-credential`, {
    method: "PUT",
    body: JSON.stringify({ apiKey: memberOneKey }),
  })
  expect(sharedSelfWrite.status).toBe(400)
  await expect(sharedSelfWrite.json()).resolves.toMatchObject({ error: "not_per_member" })

  const flipResponse = await request(ownerCookie, `/v1/llm-providers/${llmProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "Member Bound OpenAI",
      source: "custom",
      customConfig: providerConfig,
      credentialMode: "shared",
      apiKey: organizationKey,
      allMembers: true,
    }),
  })
  expect(flipResponse.status).toBe(200)
  const purgedRows = await db
    .select({ id: schema.LlmProviderMemberCredentialTable.id })
    .from(schema.LlmProviderMemberCredentialTable)
    .where(drizzle.eq(schema.LlmProviderMemberCredentialTable.llmProviderId, llmProviderId))
  expect(purgedRows).toEqual([])

  const flipBackResponse = await request(ownerCookie, `/v1/llm-providers/${llmProviderId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "Member Bound OpenAI",
      source: "custom",
      customConfig: providerConfig,
      credentialMode: "per_member",
      allMembers: true,
    }),
  })
  expect(flipBackResponse.status).toBe(200)
  const reprovisionResponse = await request(
    ownerCookie,
    `/v1/llm-providers/${llmProviderId}/member-credentials/${memberTwoId}`,
    { method: "PUT", body: JSON.stringify({ apiKey: memberTwoKey }) },
  )
  expect(reprovisionResponse.status).toBe(200)

  const removed = await orgs.removeOrganizationMember({
    organizationId,
    memberId: memberTwoId,
    removedByOrgMemberId: ownerMemberId,
  })
  expect(removed.ok).toBe(true)
  const removedMemberCredentials = await db
    .select({ id: schema.LlmProviderMemberCredentialTable.id })
    .from(schema.LlmProviderMemberCredentialTable)
    .where(drizzle.eq(schema.LlmProviderMemberCredentialTable.orgMembershipId, memberTwoId))
  expect(removedMemberCredentials).toEqual([])
})
