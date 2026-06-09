import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let queryRows: unknown[][] = []

function queryFor(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => rows,
    limit: () => rows,
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  }
  return chain
}

let llmProviderModule: typeof import("../src/routes/org/llm-providers.js")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/db.js", () => ({
    db: {
      select: () => queryFor(queryRows.shift() ?? []),
    },
  }))

  llmProviderModule = await import("../src/routes/org/llm-providers.js")
})

beforeEach(() => {
  queryRows = []
})

test("active members remain assignable to LLM provider access", async () => {
  const organizationId = createDenTypeId("organization")
  const activeMemberId = createDenTypeId("member")
  queryRows = [[{ id: activeMemberId }]]

  await expect(llmProviderModule.resolveMemberIds({
    organizationId,
    values: [activeMemberId],
  })).resolves.toEqual([activeMemberId])
})

test("removed members are rejected when assigning LLM provider access", async () => {
  const organizationId = createDenTypeId("organization")
  const removedMemberId = createDenTypeId("member")
  queryRows = [[]]

  await expect(llmProviderModule.resolveMemberIds({
    organizationId,
    values: [removedMemberId],
  })).rejects.toMatchObject({
    status: 404,
    error: "member_not_found",
  })
})

test("existing access rows to removed members are not returned as active grants", async () => {
  const organizationId = createDenTypeId("organization")
  const currentMemberId = createDenTypeId("member")
  const activeMemberId = createDenTypeId("member")
  const removedMemberId = createDenTypeId("member")
  const llmProviderId = createDenTypeId("llmProvider")
  const now = new Date("2026-06-09T00:00:00.000Z")

  queryRows = [
    [],
    [{
      id: llmProviderId,
      organizationId,
      createdByOrgMembershipId: currentMemberId,
      source: "models_dev",
      credentialKind: "api_key",
      providerId: "openai",
      name: "OpenAI",
      providerConfig: {},
      apiKey: "sk-test",
      opencodeAuth: null,
      createdAt: now,
      updatedAt: now,
    }],
    [],
    [
      {
        access: { id: createDenTypeId("llmProviderAccess"), llmProviderId, createdAt: now },
        member: { id: activeMemberId, role: "member", removedAt: null },
        user: { id: createDenTypeId("user"), name: "Active", email: "active@example.com", image: null },
      },
      {
        access: { id: createDenTypeId("llmProviderAccess"), llmProviderId, createdAt: now },
        member: { id: removedMemberId, role: "member", removedAt: new Date("2026-06-08T00:00:00.000Z") },
        user: { id: createDenTypeId("user"), name: "Removed", email: "removed@example.com", image: null },
      },
    ],
    [],
  ]

  const providers = await llmProviderModule.loadLlmProviders({
    organizationId,
    currentMemberId,
    memberTeams: [],
    isAdmin: true,
    scope: "manageable",
  })

  expect(providers).toHaveLength(1)
  expect(providers[0]?.access.members.map((member) => member.orgMembershipId)).toEqual([activeMemberId])
})
