import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type RecordedOperation = {
  kind: "delete" | "update"
  table: string
  values?: unknown
}

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const sessionId = createDenTypeId("session")
const workerId = createDenTypeId("worker")
const installLinkId = createDenTypeId("installLink")
const teamId = createDenTypeId("team")
const scimGroupId = createDenTypeId("scimGroup")
const ledgerEntryId = createDenTypeId("inferenceUsageLedgerEntry")
const telegramConnectionId = createDenTypeId("telegramConnection")
const memoryId = createDenTypeId("memory")
const llmProviderId = createDenTypeId("llmProvider")
const organizationName = "Acme Robotics"

const operations: RecordedOperation[] = []
const callOrder: string[] = []
const cancelledOrganizationIds: string[] = []

let role = "member"
let isOwner = false
let sessionCreatedAt = new Date()

function isPropertyRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null
}

function tableName(table: unknown) {
  if (!isPropertyRecord(table)) {
    return "unknown"
  }

  const nameSymbol = Object.getOwnPropertySymbols(table).find((symbol) => symbol.description === "drizzle:Name")
  const name = nameSymbol ? table[nameSymbol] : null
  return typeof name === "string" ? name : "unknown"
}

function selectRows(table: unknown): unknown[] {
  switch (tableName(table)) {
    case "member":
      return [{ id: memberId, userId }]
    case "apikey":
      return [{ id: "den_test_key", referenceId: userId, metadata: JSON.stringify({ organizationId, orgMembershipId: memberId }) }]
    case "install_link":
      return [{ id: installLinkId }]
    case "worker":
      return [{ id: workerId }]
    case "team":
      return [{ id: teamId }]
    case "scim_group":
      return [{ id: scimGroupId }]
    case "inference_usage_ledger_entries":
      return [{ id: ledgerEntryId }]
    case "telegram_connection":
      return [{ id: telegramConnectionId }]
    case "memory":
      return [{ id: memoryId }]
    case "llm_provider":
      return [{ id: llmProviderId }]
    default:
      return []
  }
}

const tx = {
  delete: (table: unknown) => ({
    where: (_condition: unknown) => {
      operations.push({ kind: "delete", table: tableName(table) })
      return Promise.resolve()
    },
  }),
  select: (_selection: unknown) => ({
    from: (table: unknown) => ({
      where: (_condition: unknown) => Promise.resolve(selectRows(table)),
    }),
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: (_condition: unknown) => {
        operations.push({ kind: "update", table: tableName(table), values })
        return Promise.resolve()
      },
    }),
  }),
}

mock.module("../src/db.js", () => ({
  db: {
    ...tx,
    transaction: async (callback: (transaction: typeof tx) => Promise<void>) => {
      callOrder.push("transaction")
      await callback(tx)
    },
  },
}))

mock.module("../src/stripe-billing.js", () => ({
  cancelOrganizationSubscriptions: (input: { organizationId: string }) => {
    callOrder.push("cancel")
    cancelledOrganizationIds.push(input.organizationId)
    return Promise.resolve()
  },
}))

mock.module("../src/orgs.js", () => ({
  getOrganizationContextForUser: (input: { organizationId: string; userId: string }) => Promise.resolve(
    input.organizationId === organizationId && input.userId === userId
      ? {
          organization: {
            id: organizationId,
            name: organizationName,
            slug: "acme-robotics",
            logo: null,
            metadata: null,
          },
          currentMember: {
            id: memberId,
            userId,
            role,
            isOwner,
            createdAt: new Date(),
          },
          members: [],
          invitations: [],
          roles: [],
          teams: [],
          currentMemberTeams: [],
        }
      : null,
  ),
  listTeamsForMember: () => Promise.resolve([]),
  resolveUserOrganizations: () => Promise.resolve({ orgs: [], activeOrgId: organizationId, activeOrgSlug: "acme-robotics" }),
  setSessionActiveOrganization: () => Promise.resolve(),
}))

let deleteOrganizationModule: typeof import("../src/routes/org/delete-organization.js")

beforeAll(async () => {
  seedRequiredEnv()
  deleteOrganizationModule = await import("../src/routes/org/delete-organization.js")
  mock.restore()
})

beforeEach(() => {
  operations.length = 0
  callOrder.length = 0
  cancelledOrganizationIds.length = 0
  role = "member"
  isOwner = false
  sessionCreatedAt = new Date()
})

afterAll(() => {
  mock.restore()
})

function createApp() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: "owner@acme.test",
      emailVerified: true,
      name: "Owner",
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", {
      id: sessionId,
      activeOrganizationId: organizationId,
      createdAt: sessionCreatedAt,
    })
    c.set("apiKey", null)
    await next()
  })
  deleteOrganizationModule.registerDeleteOrganizationRoutes(app)
  return app
}

function deleteOrganization() {
  return createApp().request("http://den.local/v1/org", { method: "DELETE" })
}

test("organization delete denies non-owners", async () => {
  role = "member"
  isOwner = false

  const response = await deleteOrganization()

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: "forbidden" })
  expect(cancelledOrganizationIds).toEqual([])
  expect(callOrder).toEqual([])
})

test("organization delete requires a fresh owner session", async () => {
  role = "owner"
  isOwner = true
  sessionCreatedAt = new Date(Date.now() - 16 * 60 * 1000)

  const response = await deleteOrganization()

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
  expect(cancelledOrganizationIds).toEqual([])
  expect(callOrder).toEqual([])
})

test("organization delete cancels subscriptions before purging org scoped rows", async () => {
  role = "owner"
  isOwner = true
  sessionCreatedAt = new Date()

  const response = await deleteOrganization()

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true, organization: { id: organizationId, name: organizationName } })
  expect(cancelledOrganizationIds).toEqual([organizationId])
  expect(callOrder).toEqual(["cancel", "transaction"])

  const deletedTables = operations
    .filter((operation) => operation.kind === "delete")
    .map((operation) => operation.table)
  expect(deletedTables).toContain("organization")
  expect(deletedTables).toContain("member")
  expect(deletedTables).toContain("invitation")
  expect(deletedTables).toContain("worker")
  expect(deletedTables).toContain("org_subscriptions")

  const sessionUpdate = operations.find((operation) => operation.kind === "update" && operation.table === "session")
  expect(sessionUpdate?.values).toEqual({ activeOrganizationId: null })
})
