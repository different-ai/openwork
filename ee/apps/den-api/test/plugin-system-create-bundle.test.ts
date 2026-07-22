import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import {
  ConfigObjectAccessGrantTable,
  ConfigObjectTable,
  ConfigObjectVersionTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginAccessGrantTable,
  PluginConfigObjectTable,
  PluginTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type TableName =
  | "config_object"
  | "config_object_access_grant"
  | "config_object_version"
  | "marketplace"
  | "marketplace_plugin"
  | "plugin"
  | "plugin_access_grant"
  | "plugin_config_object"

type Row = Record<string, unknown>

type QueryChain = {
  from: (table: unknown) => QueryChain
  innerJoin: () => QueryChain
  limit: (count?: number) => Promise<Row[]>
  orderBy: () => QueryChain
  then: <TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>
  where: () => QueryChain
}

type WriteBuilder = {
  set: (value: unknown) => { where: () => Promise<void> }
  values: (value: unknown) => Promise<void>
  where: () => Promise<void>
}

type TransactionStub = {
  insert: (table: unknown) => WriteBuilder
  select: () => QueryChain
  update: (table: unknown) => WriteBuilder
}

type InsertRecord = {
  table: TableName
  value: Row
}

const tableNames: TableName[] = [
  "config_object",
  "config_object_access_grant",
  "config_object_version",
  "marketplace",
  "marketplace_plugin",
  "plugin",
  "plugin_access_grant",
  "plugin_config_object",
]

const rowsByTable: Record<TableName, Row[]> = {
  config_object: [],
  config_object_access_grant: [],
  config_object_version: [],
  marketplace: [],
  marketplace_plugin: [],
  plugin: [],
  plugin_access_grant: [],
  plugin_config_object: [],
}

const recordedInserts: InsertRecord[] = []
let insertCalls = 0
let updateCalls = 0

function tableName(table: unknown): TableName | null {
  if (table === ConfigObjectTable) return "config_object"
  if (table === ConfigObjectAccessGrantTable) return "config_object_access_grant"
  if (table === ConfigObjectVersionTable) return "config_object_version"
  if (table === MarketplaceTable) return "marketplace"
  if (table === MarketplacePluginTable) return "marketplace_plugin"
  if (table === PluginTable) return "plugin"
  if (table === PluginAccessGrantTable) return "plugin_access_grant"
  if (table === PluginConfigObjectTable) return "plugin_config_object"
  return null
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null
}

function resetDb(seed: Partial<Record<TableName, Row[]>> = {}) {
  for (const name of tableNames) {
    rowsByTable[name] = [...(seed[name] ?? [])]
  }
  recordedInserts.length = 0
  insertCalls = 0
  updateCalls = 0
}

function rowsFor(table: TableName | null) {
  if (!table) return []
  if (table === "config_object_access_grant" || table === "plugin_access_grant") {
    return []
  }
  return rowsByTable[table]
}

function queryChain(): QueryChain {
  let selectedTable: TableName | null = null
  const resolveRows = (count?: number) => {
    const rows = rowsFor(selectedTable)
    return count === undefined ? [...rows] : rows.slice(0, count)
  }
  const chain: QueryChain = {
    from: (table) => {
      selectedTable = tableName(table)
      return chain
    },
    innerJoin: () => chain,
    limit: (count) => Promise.resolve(resolveRows(count)),
    orderBy: () => chain,
    then: (onfulfilled, onrejected) => Promise.resolve(resolveRows()).then(onfulfilled, onrejected),
    where: () => chain,
  }
  return chain
}

function recordInsert(table: TableName | null, value: unknown) {
  if (!table) return
  const values = Array.isArray(value) ? value : [value]
  for (const entry of values) {
    if (!isRecord(entry)) continue
    const stored = { ...entry }
    rowsByTable[table].push(stored)
    recordedInserts.push({ table, value: stored })
  }
}

function insertBuilder(table: unknown): WriteBuilder {
  const name = tableName(table)
  insertCalls += 1
  return {
    set: () => ({ where: () => Promise.resolve() }),
    values: (value) => {
      recordInsert(name, value)
      return Promise.resolve()
    },
    where: () => Promise.resolve(),
  }
}

function updateBuilder(_table: unknown): WriteBuilder {
  updateCalls += 1
  return {
    set: () => ({ where: () => Promise.resolve() }),
    values: () => Promise.resolve(),
    where: () => Promise.resolve(),
  }
}

const transactionStub: TransactionStub = {
  insert: insertBuilder,
  select: queryChain,
  update: updateBuilder,
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")
let schemas: typeof import("../src/routes/org/plugin-system/schemas.js")

beforeAll(async () => {
  seedRequiredEnv()

  mock.module("../src/db.js", () => ({
    db: {
      insert: insertBuilder,
      select: queryChain,
      transaction: async <TResult>(callback: (tx: TransactionStub) => Promise<TResult>) => callback(transactionStub),
      update: updateBuilder,
    },
  }))

  schemas = await import("../src/routes/org/plugin-system/schemas.js")
  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

afterAll(() => {
  mock.restore()
})

function ownerContext(organizationId = createDenTypeId("organization"), memberId = createDenTypeId("member")): PluginArchActorContext {
  const now = new Date("2026-07-05T00:00:00.000Z")
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: organizationId,
        name: "Acme Robotics",
        slug: "acme-robotics-demo",
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: memberId,
        userId: "user_admin",
        role: "owner",
        createdAt: now,
        joinedAt: now,
        isOwner: true,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
    session: { createdAt: new Date() },
  }
}

function errorStatus(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status
  }
  return null
}

test("pluginCreateSchema accepts legacy and bundle bodies while rejecting empty component input", () => {
  expect(schemas.pluginCreateSchema.safeParse({ name: "X" }).success).toBe(true)

  expect(schemas.pluginCreateSchema.safeParse({
    name: "Sales call prep",
    description: "Help the team prepare for calls.",
    components: [{
      type: "skill",
      input: {
        rawSourceText: "---\nname: sales-call-prep\ndescription: Prep calls\n---\nReview the account notes.",
      },
    }],
    orgWide: true,
    marketplaceId: createDenTypeId("marketplace"),
  }).success).toBe(true)

  expect(schemas.pluginCreateSchema.safeParse({
    name: "Broken",
    components: [{ type: "skill", input: { metadata: { name: "Broken" } } }],
  }).success).toBe(false)
})

test("createPluginBundle rejects an unknown marketplace before any write", async () => {
  resetDb()

  let status: number | null = null
  try {
    await storeModule.createPluginBundle({
      context: ownerContext(),
      marketplaceId: createDenTypeId("marketplace"),
      name: "Bundle with missing marketplace",
    })
    throw new Error("expected rejection")
  } catch (error) {
    status = errorStatus(error)
  }

  expect(status).toBe(404)
  expect(insertCalls).toBe(0)
  expect(updateCalls).toBe(0)
})

test("createPluginBundle composes component creation, org-wide grants, and marketplace publishing", async () => {
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  const now = new Date("2026-07-05T00:00:00.000Z")
  const marketplace = {
    id: createDenTypeId("marketplace"),
    organizationId,
    name: "OpenWork Marketplace",
    description: "Company extensions",
    logoUrl: null,
    status: "active",
    createdByOrgMembershipId: memberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }
  resetDb({ marketplace: [marketplace] })

  await storeModule.createPluginBundle({
    components: [{
      type: "skill",
      value: {
        rawSourceText: "---\nname: sales-call-prep\ndescription: Prep calls\n---\nReview the account notes.",
      },
    }],
    context: ownerContext(organizationId, memberId),
    description: "Help the team prepare for sales calls.",
    marketplaceId: marketplace.id,
    name: "Sales call prep",
    orgWide: true,
  })

  expect(recordedInserts).toHaveLength(9)
  expect(recordedInserts.filter((entry) => entry.table === "plugin")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "plugin_access_grant")).toHaveLength(2)
  expect(recordedInserts.filter((entry) => entry.table === "config_object")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "config_object_version")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "config_object_access_grant")).toHaveLength(2)
  expect(recordedInserts.filter((entry) => entry.table === "plugin_config_object")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "marketplace_plugin")).toHaveLength(1)
  expect(recordedInserts.some((entry) => entry.table === "config_object_access_grant" && entry.value.orgWide === true && entry.value.role === "viewer")).toBe(true)
  expect(recordedInserts.some((entry) => entry.table === "plugin_access_grant" && entry.value.orgWide === true && entry.value.role === "viewer")).toBe(true)
  expect(recordedInserts.some((entry) => entry.table === "marketplace_plugin" && entry.value.marketplaceId === marketplace.id)).toBe(true)
})
