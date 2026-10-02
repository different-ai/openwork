import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// Hosted-web workers get their providers from den-api's database store, not
// from the member's desktop. A per-member provider stores no organization key,
// so the store must resolve the worker owner's own binding, and only for
// providers the owner is granted, exactly as the connect route does.

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_cloud_member_creds"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "z".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** The worker routes den-api writes to, with the state they hold. */
function makeWorkerInstance() {
  const env = new Map<string, string>()
  const providers: Record<string, unknown> = {}
  async function fetchImpl(url: string, init: RequestInit = {}) {
    const { pathname } = new URL(url)
    const method = init.method ?? "GET"
    const body: unknown = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null
    if (method === "GET" && pathname === "/opencode/config") return jsonResponse({ provider: providers })
    if (pathname.startsWith("/env/")) {
      const key = decodeURIComponent(pathname.slice("/env/".length))
      const value = env.get(key)
      if (method === "DELETE") {
        env.delete(key)
        return jsonResponse({ ok: true })
      }
      return value === undefined ? jsonResponse({ error: "env_not_found" }, 404) : jsonResponse({ item: { key, value } })
    }
    if (method === "PUT" && pathname === "/env" && isRecord(body) && Array.isArray(body.entries)) {
      for (const entry of body.entries) {
        if (isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string") env.set(entry.key, entry.value)
      }
      return jsonResponse({ ok: true })
    }
    if (method === "PATCH" && pathname === "/runtime-config/providers" && isRecord(body) && isRecord(body.provider)) {
      for (const [id, config] of Object.entries(body.provider)) {
        if (config === null) delete providers[id]
        else providers[id] = config
      }
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ error: "unexpected_request" }, 500)
  }
  return { env, providers, fetchImpl }
}

type Materializer = typeof import("../src/llm/cloud-provider-materialization.js").materializeCloudWorkerProviders
let materializeCloudWorkerProviders: Materializer
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

const organizationId = createDenTypeId("organization")
const ownerUserId = createDenTypeId("user")
const teammateUserId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")
const teammateMemberId = createDenTypeId("member")
const teamId = createDenTypeId("team")
const ownerWorkerId = createDenTypeId("worker")
const teammateWorkerId = createDenTypeId("worker")

const providers = {
  everyone: { id: createDenTypeId("llmProvider"), env: "EVERYONE_GATEWAY_API_KEY" },
  ownerTeam: { id: createDenTypeId("llmProvider"), env: "TEAM_GATEWAY_API_KEY" },
  teammateOnly: { id: createDenTypeId("llmProvider"), env: "TEAMMATE_GATEWAY_API_KEY" },
  blockedForOwner: { id: createDenTypeId("llmProvider"), env: "BLOCKED_GATEWAY_API_KEY" },
  shared: { id: createDenTypeId("llmProvider"), env: "SHARED_GATEWAY_API_KEY" },
}
const providerIds = Object.values(providers).map((provider) => provider.id)

function providerRow(key: keyof typeof providers, credentialMode: "shared" | "per_member", apiKey: string | null) {
  const provider = providers[key]
  const id = `${key}-gateway`
  return {
    id: provider.id,
    organizationId,
    createdByOrgMembershipId: ownerMemberId,
    source: "custom" as const,
    providerId: id,
    name: id,
    providerConfig: { id, name: id, npm: "@ai-sdk/openai-compatible", env: [provider.env], api: `https://${id}.example.test/v1` },
    credentialMode,
    apiKey,
  }
}

function credentialRow(key: keyof typeof providers, orgMembershipId: typeof ownerMemberId, secret: string, state: "active" | "blocked" = "active") {
  return {
    id: createDenTypeId("llmProviderMemberCredential"),
    organizationId,
    llmProviderId: providers[key].id,
    orgMembershipId,
    secret,
    state,
    createdBy: "admin" as const,
  }
}

async function materializeFor(workerId: typeof ownerWorkerId) {
  const instance = makeWorkerInstance()
  const logs: Array<{ message: string; metadata?: Record<string, unknown> }> = []
  const result = await materializeCloudWorkerProviders({
    organizationId,
    workerId,
    instanceUrl: `https://${workerId}.worker.example.test`,
    hostToken: "host-token",
    clientToken: "client-token",
    force: true,
    fetchImpl: instance.fetchImpl,
    logger: {
      warn: (message, metadata) => logs.push({ message, metadata }),
      error: (message, metadata) => logs.push({ message, metadata }),
    },
  })
  return { result, instance, logs }
}

function skippedProviderIds(logs: Array<{ message: string; metadata?: Record<string, unknown> }>) {
  return logs
    .filter((log) => log.message === "cloud provider skipped without a usable credential")
    .map((log) => log.metadata?.provider_id)
    .sort()
}

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [dbModule, schemaModule, drizzleModule, materializer] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/llm/cloud-provider-materialization.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  materializeCloudWorkerProviders = materializer.materializeCloudWorkerProviders

  await db.insert(schema.AuthUserTable).values([
    { id: ownerUserId, name: "Worker Owner", email: `worker-owner+${ownerUserId}@test.local`, emailVerified: true },
    { id: teammateUserId, name: "Teammate", email: `teammate+${teammateUserId}@test.local`, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Cloud Member Credentials",
    slug: `cloud-member-credentials-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: ownerMemberId, organizationId, userId: ownerUserId, role: "owner" },
    { id: teammateMemberId, organizationId, userId: teammateUserId, role: "member" },
  ])
  await db.insert(schema.TeamTable).values({ id: teamId, name: "Owner team", organizationId })
  await db.insert(schema.TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId,
    orgMembershipId: ownerMemberId,
    userId: ownerUserId,
  })
  await db.insert(schema.WorkerTable).values([
    { id: ownerWorkerId, org_id: organizationId, created_by_user_id: ownerUserId, name: "Cloud", destination: "cloud", status: "healthy" },
    { id: teammateWorkerId, org_id: organizationId, created_by_user_id: teammateUserId, name: "Cloud", destination: "cloud", status: "healthy" },
  ])
  await db.insert(schema.LlmProviderTable).values([
    providerRow("everyone", "per_member", null),
    providerRow("ownerTeam", "per_member", null),
    providerRow("teammateOnly", "per_member", null),
    providerRow("blockedForOwner", "per_member", null),
    providerRow("shared", "shared", "org-shared-key"),
  ])
  await db.insert(schema.LlmProviderModelTable).values(providerIds.map((llmProviderId) => ({
    id: createDenTypeId("llmProviderModel"),
    llmProviderId,
    modelId: "team-model",
    name: "Team model",
    modelConfig: { id: "team-model", name: "Team model" },
  })))
  await db.insert(schema.LlmProviderAccessTable).values([
    { id: createDenTypeId("llmProviderAccess"), llmProviderId: providers.everyone.id, orgMembershipId: null, teamId: null },
    { id: createDenTypeId("llmProviderAccess"), llmProviderId: providers.ownerTeam.id, orgMembershipId: null, teamId },
    { id: createDenTypeId("llmProviderAccess"), llmProviderId: providers.teammateOnly.id, orgMembershipId: teammateMemberId, teamId: null },
    { id: createDenTypeId("llmProviderAccess"), llmProviderId: providers.blockedForOwner.id, orgMembershipId: null, teamId: null },
    { id: createDenTypeId("llmProviderAccess"), llmProviderId: providers.shared.id, orgMembershipId: null, teamId: null },
  ])
  await db.insert(schema.LlmProviderMemberCredentialTable).values([
    credentialRow("everyone", ownerMemberId, "owner-everyone-token"),
    credentialRow("everyone", teammateMemberId, "teammate-everyone-token"),
    credentialRow("ownerTeam", ownerMemberId, "owner-team-token"),
    credentialRow("ownerTeam", teammateMemberId, "teammate-team-token"),
    credentialRow("teammateOnly", ownerMemberId, "owner-leftover-token"),
    credentialRow("teammateOnly", teammateMemberId, "teammate-only-token"),
    credentialRow("blockedForOwner", ownerMemberId, "owner-blocked-token", "blocked"),
    credentialRow("blockedForOwner", teammateMemberId, "teammate-blocked-provider-token"),
  ])
})

afterAll(async () => {
  if (!db || !schema || !drizzle) {
    mock.restore()
    return
  }
  const { eq, inArray } = drizzle
  await db.delete(schema.LlmProviderMemberCredentialTable).where(inArray(schema.LlmProviderMemberCredentialTable.llmProviderId, providerIds))
  await db.delete(schema.LlmProviderAccessTable).where(inArray(schema.LlmProviderAccessTable.llmProviderId, providerIds))
  await db.delete(schema.LlmProviderModelTable).where(inArray(schema.LlmProviderModelTable.llmProviderId, providerIds))
  await db.delete(schema.LlmProviderTable).where(inArray(schema.LlmProviderTable.id, providerIds))
  await db.delete(schema.WorkerTable).where(inArray(schema.WorkerTable.id, [ownerWorkerId, teammateWorkerId]))
  await db.delete(schema.TeamMemberTable).where(eq(schema.TeamMemberTable.teamId, teamId))
  await db.delete(schema.TeamTable).where(eq(schema.TeamTable.id, teamId))
  await db.delete(schema.MemberTable).where(eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(inArray(schema.AuthUserTable.id, [ownerUserId, teammateUserId]))
  mock.restore()
})

describe("hosted-web providers with per-member credentials", () => {
  test("the owner's worker uses the owner's own credential for every per-member provider they are granted", async () => {
    const { result, instance } = await materializeFor(ownerWorkerId)

    expect(result).toMatchObject({ ok: true, status: "applied", providers: 3 })
    expect(Object.keys(instance.providers).sort()).toEqual([providers.everyone.id, providers.ownerTeam.id, providers.shared.id].sort())
    expect(instance.env.get(providers.everyone.env)).toBe("owner-everyone-token")
    expect(instance.env.get(providers.ownerTeam.env)).toBe("owner-team-token")
    expect(instance.env.get(providers.shared.env)).toBe("org-shared-key")
  })

  test("a provider the owner is not granted, or whose credential is blocked, stays out of the owner's worker", async () => {
    const { instance, logs } = await materializeFor(ownerWorkerId)

    expect(instance.providers).not.toHaveProperty(providers.teammateOnly.id)
    expect(instance.providers).not.toHaveProperty(providers.blockedForOwner.id)
    expect(instance.env.has(providers.teammateOnly.env)).toBe(false)
    expect(instance.env.has(providers.blockedForOwner.env)).toBe(false)
    expect([...instance.env.values()].filter((value) => value.startsWith("teammate-"))).toEqual([])
    expect(skippedProviderIds(logs)).toEqual([providers.teammateOnly.id, providers.blockedForOwner.id].sort())
  })

  test("a teammate's worker uses the teammate's credentials and only the teammate's grants", async () => {
    const { result, instance } = await materializeFor(teammateWorkerId)

    expect(result).toMatchObject({ ok: true, status: "applied", providers: 4 })
    expect(Object.keys(instance.providers).sort()).toEqual(
      [providers.everyone.id, providers.teammateOnly.id, providers.blockedForOwner.id, providers.shared.id].sort(),
    )
    expect(instance.env.get(providers.everyone.env)).toBe("teammate-everyone-token")
    expect(instance.env.get(providers.teammateOnly.env)).toBe("teammate-only-token")
    expect(instance.env.get(providers.blockedForOwner.env)).toBe("teammate-blocked-provider-token")
    expect(instance.env.has(providers.ownerTeam.env)).toBe(false)
    expect([...instance.env.values()].filter((value) => value.startsWith("owner-"))).toEqual([])
  })
})
