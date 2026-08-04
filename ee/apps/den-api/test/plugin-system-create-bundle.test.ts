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
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
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

type UpdateRecord = {
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
const recordedUpdates: UpdateRecord[] = []
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
  recordedUpdates.length = 0
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

function updateBuilder(table: unknown): WriteBuilder {
  const name = tableName(table)
  updateCalls += 1
  return {
    set: (value) => {
      if (name && isRecord(value)) {
        recordedUpdates.push({ table: name, value: { ...value } })
      }
      return { where: () => Promise.resolve() }
    },
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

function routeFailure(error: unknown) {
  if (typeof error !== "object" || error === null) return null
  if (!("error" in error) || typeof error.error !== "string") return null
  if (!("message" in error) || typeof error.message !== "string") return null
  return { error: error.error, message: error.message }
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

test("createPluginBundle rejects invalid standard SKILL.md content before any write", async () => {
  const invalidSkills = [
    {
      value: { normalizedPayloadJson: { name: "missing-source" } },
      error: "invalid_skill_source",
      message: "Skill components require rawSourceText containing the complete SKILL.md.",
    },
    {
      value: { rawSourceText: "# Missing frontmatter\n\nInstructions." },
      error: "invalid_skill_frontmatter",
      message: "SKILL.md must start with YAML frontmatter delimited by --- lines.",
    },
    {
      value: { rawSourceText: "---\ndescription: Missing name\n---\nInstructions." },
      error: "invalid_skill_name",
      message: "SKILL.md frontmatter requires a non-empty name.",
    },
    {
      value: { rawSourceText: "---\nname: Invalid--Name\ndescription: Invalid name\n---\nInstructions." },
      error: "invalid_skill_name",
      message: "SKILL.md frontmatter name must be 1-64 characters, contain only lowercase letters, numbers, and hyphens, and cannot start, end, or use consecutive hyphens.",
    },
    {
      value: { rawSourceText: `---\nname: ${"a".repeat(65)}\ndescription: Name is too long\n---\nInstructions.` },
      error: "invalid_skill_name",
      message: "SKILL.md frontmatter name must be 1-64 characters, contain only lowercase letters, numbers, and hyphens, and cannot start, end, or use consecutive hyphens.",
    },
    {
      value: { rawSourceText: "---\nname: missing-description\n---\nInstructions." },
      error: "invalid_skill_description",
      message: "SKILL.md frontmatter requires a non-empty description.",
    },
    {
      value: { rawSourceText: `---\nname: long-description\ndescription: ${"x".repeat(1_025)}\n---\nInstructions.` },
      error: "invalid_skill_description",
      message: "SKILL.md frontmatter description must be 1024 characters or fewer.",
    },
    {
      value: { rawSourceText: "---\nname: missing-body\ndescription: Missing body\n---\n" },
      error: "invalid_skill_body",
      message: "SKILL.md requires a non-empty Markdown instruction body after the frontmatter.",
    },
  ]

  for (const invalidSkill of invalidSkills) {
    resetDb()
    let failure: ReturnType<typeof routeFailure> = null
    let status: number | null = null
    try {
      await storeModule.createPluginBundle({
        components: [{ type: "skill", value: invalidSkill.value }],
        context: ownerContext(),
        name: "Invalid skill",
      })
      throw new Error("expected rejection")
    } catch (error) {
      failure = routeFailure(error)
      status = errorStatus(error)
    }

    expect(status).toBe(400)
    expect(failure).toEqual({ error: invalidSkill.error, message: invalidSkill.message })
    expect(insertCalls).toBe(0)
    expect(updateCalls).toBe(0)
  }
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

test("createConfigObjectVersion updates a same-name skill without creating a duplicate", async () => {
  resetDb()
  const skillName = "sales-call-prep"
  const originalSkill = `---\nname: ${skillName}\ndescription: Prepare for sales calls.\n---\nReview the account notes.`

  await storeModule.createPluginBundle({
    components: [{ type: "skill", value: { rawSourceText: originalSkill } }],
    context: ownerContext(),
    name: "Sales call prep",
  })

  const configObject = recordedInserts.find((entry) => entry.table === "config_object")
  if (!configObject || typeof configObject.value.id !== "string") {
    throw new Error("expected created skill config object")
  }

  const updatedSkill = `---\nname: ${skillName}\ndescription: Prepare for sales calls from current account notes.\n---\nReview the account notes and list the open risks.`
  const configObjectId = normalizeDenTypeId("configObject", configObject.value.id)
  await storeModule.createConfigObjectVersion({
    configObjectId,
    context: ownerContext(),
    reason: "Improve preparation guidance",
    value: { rawSourceText: updatedSkill },
  })

  expect(recordedInserts.filter((entry) => entry.table === "plugin")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "config_object")).toHaveLength(1)
  expect(recordedInserts.filter((entry) => entry.table === "config_object_version")).toHaveLength(2)
  expect(recordedInserts.at(-1)?.value).toMatchObject({
    configObjectId,
    rawSourceText: updatedSkill,
    sourceRevisionRef: "Improve preparation guidance",
  })
  expect(recordedUpdates).toContainEqual({
    table: "config_object",
    value: expect.objectContaining({
      description: "Prepare for sales calls from current account notes.",
      searchText: [
        skillName,
        "Prepare for sales calls from current account notes.",
        "Review the account notes and list the open risks.",
      ].join("\n"),
      title: skillName,
    }),
  })
})

test("createConfigObject atomically persists a skill on its owning plugin", async () => {
  resetDb()
  const context = ownerContext()
  await storeModule.createPluginBundle({ context, name: "Incident response" })
  const plugin = recordedInserts.find((entry) => entry.table === "plugin")
  if (!plugin || typeof plugin.value.id !== "string") {
    throw new Error("expected created plugin")
  }

  const pluginId = normalizeDenTypeId("plugin", plugin.value.id)
  const rawSourceText = "---\nname: incident-response\ndescription: Coordinate an incident.\n---\nCapture impact.\n\nAssign owners."
  const skill = await storeModule.createConfigObject({
    context,
    objectType: "skill",
    pluginIds: [pluginId],
    sourceMode: "cloud",
    value: { rawSourceText },
  })

  expect(skill).toMatchObject({
    objectType: "skill",
    organizationId: context.organizationContext.organization.id,
    latestVersion: { rawSourceText },
  })
  expect(recordedInserts).toContainEqual({
    table: "plugin_config_object",
    value: expect.objectContaining({
      configObjectId: skill.id,
      organizationId: context.organizationContext.organization.id,
      pluginId,
    }),
  })
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
  const skillMarkdown = [
    "---",
    "name: sales-call-prep",
    "description: >",
    "  Prepare for sales calls from account notes.",
    "  Use before customer meetings.",
    "---",
    "",
    "# Sales call preparation",
    "",
    "Review the account notes.",
  ].join("\n")

  await storeModule.createPluginBundle({
    components: [{
      type: "skill",
      value: {
        metadata: { title: "Caller title", description: "Caller description" },
        rawSourceText: skillMarkdown,
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
  const configObjectInserts = recordedInserts.filter((entry) => entry.table === "config_object")
  expect(configObjectInserts[0]?.value.title).toBe("sales-call-prep")
  expect(configObjectInserts[0]?.value.description).toBe("Prepare for sales calls from account notes. Use before customer meetings.")
  expect(configObjectInserts[0]?.value.searchText).toBe([
    "sales-call-prep",
    "Prepare for sales calls from account notes. Use before customer meetings.",
    "# Sales call preparation\n\nReview the account notes.",
  ].join("\n"))
  const versionInserts = recordedInserts.filter((entry) => entry.table === "config_object_version")
  expect(versionInserts[0]?.value.rawSourceText).toBe(skillMarkdown)
  expect(versionInserts[0]?.value.normalizedPayloadJson).toBeNull()
  expect(versionInserts[0]?.value.schemaVersion).toBeNull()
  expect(JSON.stringify(versionInserts)).not.toContain(["den", "skill"].join("_"))
  expect(recordedInserts.some((entry) => entry.table === "config_object_access_grant" && entry.value.orgWide === true && entry.value.role === "viewer")).toBe(true)
  expect(recordedInserts.some((entry) => entry.table === "plugin_access_grant" && entry.value.orgWide === true && entry.value.role === "viewer")).toBe(true)
  expect(recordedInserts.some((entry) => entry.table === "marketplace_plugin" && entry.value.marketplaceId === marketplace.id)).toBe(true)
})
