import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  delete process.env.LINEAR_API_KEY
  delete process.env.LINEAR_COMPLIANCE_TEAM_ID
  delete process.env.LINEAR_API_BASE
  delete process.env.LINEAR_COMPLIANCE_COMPLETED_STATE_ID
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
const organizationCreatedAt = new Date("2026-02-03T04:05:06.789Z")
const linearIssueId = "linear_issue_123"

const operations: RecordedOperation[] = []
const callOrder: string[] = []
const cancelledOrganizationIds: string[] = []
const linearCreatedIssues: { title: string; description: string }[] = []
const linearCompletedIssueIds: string[] = []

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
    case "organization":
      return [{ id: organizationId, name: organizationName, createdAt: organizationCreatedAt }]
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
let linearClientModule: typeof import("../src/linear-client.js")

beforeAll(async () => {
  seedRequiredEnv()
  linearClientModule = await import("../src/linear-client.js")
  mock.module("../src/linear.js", () => ({
    createLinearIssue: (input: { title: string; description: string }) => {
      callOrder.push("linear:create")
      linearCreatedIssues.push(input)
      return Promise.resolve({ id: linearIssueId, identifier: "DEL-1", url: "https://linear.app/openwork/issue/DEL-1" })
    },
    completeLinearIssue: (input: { issueId: string }) => {
      callOrder.push("linear:complete")
      linearCompletedIssueIds.push(input.issueId)
      return Promise.resolve(true)
    },
  }))
  deleteOrganizationModule = await import("../src/routes/org/delete-organization.js")
  mock.restore()
})

beforeEach(() => {
  operations.length = 0
  callOrder.length = 0
  cancelledOrganizationIds.length = 0
  linearCreatedIssues.length = 0
  linearCompletedIssueIds.length = 0
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

function deleteOrganization(init: Omit<RequestInit, "method"> = {}) {
  return createApp().request("http://den.local/v1/org", { ...init, method: "DELETE" })
}

test("Linear helpers no-op without credentials", async () => {
  const config = { apiBase: "https://api.linear.app/graphql" }
  await expect(linearClientModule.createLinearIssue({ title: "Noop", description: "No Linear credentials" }, config)).resolves.toBeNull()
  await expect(linearClientModule.completeLinearIssue({ issueId: linearIssueId }, config)).resolves.toBe(false)
})

test("organization delete denies non-owners", async () => {
  role = "member"
  isOwner = false

  const response = await deleteOrganization()

  expect(response.status).toBe(403)
  await expect(response.json()).resolves.toEqual({ error: "forbidden" })
  expect(cancelledOrganizationIds).toEqual([])
  expect(callOrder).toEqual([])
  expect(linearCreatedIssues).toEqual([])
  expect(linearCompletedIssueIds).toEqual([])
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
  expect(linearCreatedIssues).toEqual([])
  expect(linearCompletedIssueIds).toEqual([])
})

test("organization delete tracks Linear ticket around purging org scoped rows", async () => {
  role = "owner"
  isOwner = true
  sessionCreatedAt = new Date()

  const response = await deleteOrganization({
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
      "cf-ipcountry": "GB",
    },
    body: JSON.stringify({ confirmation: organizationName }),
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true, organization: { id: organizationId, name: organizationName } })
  expect(cancelledOrganizationIds).toEqual([organizationId])
  expect(callOrder).toEqual(["linear:create", "cancel", "transaction", "linear:complete"])
  expect(linearCompletedIssueIds).toEqual([linearIssueId])
  expect(linearCreatedIssues).toHaveLength(1)
  expect(linearCreatedIssues[0]?.title).toBe(`[ACCOUNT DELETION]: ${organizationId}`)
  const description = linearCreatedIssues[0]?.description ?? ""
  expect(description).toContain("Request source: self serve request")
  expect(description).toContain("Request ID: req_")
  expect(description).toContain(`Requester user ID: ${userId}`)
  expect(description).toContain("Requester email: owner@acme.test")
  expect(description).toContain("Requester name: Owner")
  expect(description).toContain(`Database user id: ${userId}`)
  expect(description).toContain(`Organization ID: ${organizationId}`)
  expect(description).toContain(`Organization name: ${organizationName}`)
  expect(description).toContain("Number of members: 1")
  expect(description).toContain(`Organization creation date: ${organizationCreatedAt.toISOString()}`)
  expect(description).toContain(`Confirmation string: ${organizationName}`)
  expect(description).toContain("x-forwarded-for: 203.0.113.9")
  expect(description).toContain("country: GB")

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
