import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import {
  ConfigObjectAccessGrantTable, ConfigObjectTable, ConfigObjectVersionTable,
  MemberTable, PluginTable, WorkflowRunTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest } from "../src/workflow-artifacts.js"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"
import type { createWorkflowRunnerService } from "../src/mcp/workflow-runner-service.js"

type Row = Record<string, unknown>
let createService: typeof createWorkflowRunnerService
let marketplace: typeof import("../src/mcp/marketplace-capabilities.js")
let context: Parameters<typeof createWorkflowRunnerService>[0]
const tables = new Map<unknown, Row[]>()
const conditions: Array<{ table: unknown; condition: unknown }> = []
const calls: Array<{ name: string; input: unknown }> = []
let manifest: BuiltCodemodeTools["manifest"] = []
let toolResult: unknown = { count: 2 }
const buildTools = mock(async (): Promise<BuiltCodemodeTools> => ({
  tools: { den: { read: definition("read"), write: definition("write") } }, manifest,
}))

function definition(name: string) {
  return Tool.make({ description: name, input: { type: "object" }, run: (input) => Effect.sync(() => {
    calls.push({ name, input })
    return toolResult
  }) })
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function record(value: unknown): Row {
  if (!isRecord(value)) throw new Error("Expected object")
  return value
}
function rows(table: unknown) { return tables.get(table) ?? [] }
function put(table: unknown, value: Row) { tables.set(table, [...rows(table), value]) }
function parameters(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return []
  if ("value" in value && "encoder" in value) return [value.value]
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) return value.queryChunks.flatMap(parameters)
  if (Array.isArray(value)) return value.flatMap(parameters)
  return []
}
function contains(value: unknown, column: unknown): boolean {
  if (value === column) return true
  if (typeof value !== "object" || value === null) return false
  return "queryChunks" in value && Array.isArray(value.queryChunks) && value.queryChunks.some((child) => contains(child, column))
}

const database = {
  select: () => ({ from: (table: unknown) => {
    let condition: unknown
    let descending = false
    let maximum = Infinity
    const selected = () => {
      const values = parameters(condition)
      let result = [...rows(table)]
      const fields: Array<[string, string]> = [
        ["org_", "organizationId"], ["om_", "id"], ["cov_", "id"],
        ["cob_", table === ConfigObjectTable ? "id" : "configObjectId"],
        ["plg_", table === PluginTable ? "id" : "pluginId"],
      ]
      for (const [prefix, field] of fields) {
        const ids = values.filter((value) => typeof value === "string" && value.startsWith(prefix))
        if (ids.length > 0) result = result.filter((row) => row[field] === undefined || ids.includes(row[field]))
      }
      if (table === MemberTable) result = result.filter((row) => row.removedAt === null)
      if (table === ConfigObjectTable) result = result.filter((row) => row.status === "active" && row.deletedAt === null)
      if (table === ConfigObjectVersionTable && contains(condition, ConfigObjectVersionTable.isDeletedVersion)) {
        result = result.filter((row) => row.isDeletedVersion === false)
      }
      if (descending && table === ConfigObjectVersionTable) result.reverse()
      result = result.slice(0, maximum)
      if (table === ConfigObjectTable) return result.map((configObject) => ({
        configObject, plugin: rows(PluginTable).find((plugin) => plugin.id === configObject.pluginId), marketplace: null,
      }))
      if (table === ConfigObjectAccessGrantTable) return result.map((row) => ({ ...row, resourceId: row.configObjectId }))
      return result
    }
    const query = {
      where: (value: unknown) => { condition = value; conditions.push({ table, condition }); return query },
      innerJoin: () => query,
      orderBy: () => { descending = true; return query },
      limit: (value: number) => { maximum = value; return query },
      then: (resolve: (result: Row[]) => unknown) => Promise.resolve(selected()).then(resolve),
    }
    return query
  } }),
  insert: (table: unknown) => ({ values: async (value: Row) => { put(table, value) } }),
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: database }))
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  createService = (await import("../src/mcp/workflow-runner-service.js")).createWorkflowRunnerService
})
afterAll(() => mock.restore())
beforeEach(() => {
  tables.clear()
  conditions.length = 0
  calls.length = 0
  buildTools.mockClear()
  toolResult = { count: 2 }
  manifest = [
    { capabilityName: "read", scriptPath: "tools.den.read", authority: "den", readOnly: true },
    { capabilityName: "write", scriptPath: "tools.den.write", authority: "den", readOnly: false },
  ]
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  context = { organizationId, member: { orgMembershipId, teamIds: [] }, scopes: new Set(["mcp:read"]), enabled: true, buildTools }
  put(MemberTable, { id: orgMembershipId, organizationId, role: "member", removedAt: null })
  put(PluginTable, { id: createDenTypeId("plugin"), organizationId, name: "My Workflows" })
})

const runtimeSchema = { type: "object", additionalProperties: false, required: ["runtime"], properties: {
  runtime: { type: "object", additionalProperties: false, required: ["now", "today", "timeZone", "dayStart", "dayEnd"],
    properties: Object.fromEntries(["now", "today", "timeZone", "dayStart", "dayEnd"].map((key) => [key, { type: "string" }])) },
} }
const outputSchema = { type: "object", required: ["count"], properties: { count: { type: "number" } }, additionalProperties: false }
function seed(options: { title?: string; code?: string; payload?: Row; deleted?: boolean } = {}) {
  const pluginId = String(rows(PluginTable)[0]?.id)
  const configObjectId = createDenTypeId("configObject")
  const configObjectVersionId = createDenTypeId("configObjectVersion")
  put(ConfigObjectTable, { id: configObjectId, pluginId, organizationId: context.organizationId, objectType: "workflow",
    title: options.title ?? "Daily summary", description: "Current totals", status: "active", deletedAt: null })
  put(ConfigObjectVersionTable, { id: configObjectVersionId, configObjectId, organizationId: context.organizationId,
    isDeletedVersion: options.deleted ?? false, rawSourceText: options.code ?? "return await tools.den.read(input.runtime)",
    normalizedPayloadJson: { language: "codemode-js", inputSchema: runtimeSchema, outputSchema,
      requiredCapabilities: [{ capabilityName: "read", scriptPath: "tools.den.read" }], ...options.payload } })
  put(ConfigObjectAccessGrantTable, { configObjectId, organizationId: context.organizationId,
    orgMembershipId: context.member?.orgMembershipId, role: "viewer", removedAt: null })
  return { pluginId, configObjectId, configObjectVersionId }
}
function payload() { return record(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson) }
function witnesses() {
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)).toEqual([])
}

test("empty accessible catalog needs no Workflow, tool construction or execution", async () => {
  expect(await createService(context).open({})).toEqual({ schemaVersion: "1", kind: "workflow_catalog", workflows: [], hasMore: false })
  expect(buildTools).not.toHaveBeenCalled()
  witnesses()
})

test("catalog is member-authorized, searched and bounded to twenty without execution", async () => {
  for (let index = 0; index < 23; index++) seed({ title: `Summary ${String(index).padStart(2, "0")}` })
  const service = createService(context)
  const catalog = await service.open({})
  expect(catalog.kind).toBe("workflow_catalog")
  if (catalog.kind !== "workflow_catalog") throw new Error("Expected catalog")
  expect(catalog.workflows).toHaveLength(20)
  expect(catalog.hasMore).toBe(true)
  expect(catalog.workflows.every((workflow) => workflow.blockedReason === null)).toBe(true)
  expect(JSON.stringify(catalog)).not.toContain("requiredCapabilities")
  expect(JSON.stringify(catalog)).not.toContain("inputSchema")
  expect(await service.open({ query: " SUMMARY 22 " })).toMatchObject({ workflows: [{ title: "Summary 22" }], hasMore: false })
  tables.set(ConfigObjectAccessGrantTable, [])
  expect(await service.open({})).toMatchObject({ workflows: [], hasMore: false })
  witnesses()
})

test("run normalizes IDs, supplies fresh server runtime, validates output, and returns no code or logs", async () => {
  const saved = seed({ code: 'console.log("private-log"); return await tools.den.read(input.runtime)' })
  const service = createService(context)
  for (const timeZone of [undefined, "America/Los_Angeles"]) {
    const before = Date.now()
    const result = await service.run({
      pluginId: ` ${saved.pluginId} `, configObjectId: ` ${saved.configObjectId} `,
      configObjectVersionId: ` ${saved.configObjectVersionId} `, timeZone,
    })
    expect(result).toMatchObject({ kind: "workflow_result", workflow: saved, value: { count: 2 },
      resultDigest: artifactDigest({ count: 2 }), outputSchemaDigest: artifactDigest(outputSchema) })
    const runtime = record(calls.at(-1)?.input)
    expect(Date.parse(String(runtime.now))).toBeGreaterThanOrEqual(before)
    expect(Date.parse(String(runtime.now))).toBeLessThanOrEqual(Date.now())
    expect(runtime).toEqual(artifactRuntime(timeZone, new Date(String(runtime.now))))
    expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ source: `live:plugin:${saved.pluginId}:${saved.configObjectId}`,
      config_object_version_id: saved.configObjectVersionId, validated_result: { count: 2 },
      script_input: null, script_input_digest: artifactDigest({ runtime }) })
    expect(JSON.stringify(result)).not.toContain("private-log")
    expect(result).not.toHaveProperty("code")
    expect(result).not.toHaveProperty("logs")
    expect(result).not.toHaveProperty("toolCalls")
  }
  expect(calls).toHaveLength(2)
})

test("no-input Workflows run with runtime and no dependency tools exposed", async () => {
  const saved = seed({ code: "return input", payload: { inputSchema: undefined, outputSchema: runtimeSchema, requiredCapabilities: [] } })
  expect(await createService(context).run(saved)).toMatchObject({ kind: "workflow_result", value: { runtime: { timeZone: "UTC" } } })
  expect(calls).toEqual([])
})

test("Den writes, external readOnly hints, absent authority and missing dependencies are blocked without execution", async () => {
  const saved = seed()
  const service = createService(context)
  for (const current of [
    { capabilityName: "read", scriptPath: "tools.den.read", authority: "den", readOnly: false },
    { capabilityName: "read", scriptPath: "tools.den.read", authority: "external", readOnly: true },
    { capabilityName: "read", scriptPath: "tools.den.read", readOnly: true },
    { capabilityName: "read", scriptPath: "tools.den.read", authority: "den" },
    { capabilityName: "wrong", scriptPath: "tools.den.read", authority: "den", readOnly: true },
  ] satisfies BuiltCodemodeTools["manifest"]) {
    manifest = [current]
    const catalog = await service.open({})
    expect(catalog.kind).toBe("workflow_catalog")
    if (catalog.kind === "workflow_catalog") expect(catalog.workflows[0]?.blockedReason).toBeTruthy()
    expect(await service.run(saved)).toMatchObject({ kind: "workflow_error", error: "workflow_blocked" })
    witnesses()
  }
  manifest = [{ capabilityName: "absent", scriptPath: "tools.den.absent", authority: "den", readOnly: true }]
  payload().requiredCapabilities = [{ capabilityName: "absent", scriptPath: "tools.den.absent" }]
  expect(await service.run(saved)).toMatchObject({ error: "workflow_blocked" })
  witnesses()
})

test("undeclared dynamic write cannot reach a provider even when omitted from requirements", async () => {
  const saved = seed({ code: 'return await tools.den["write"]({})', payload: { requiredCapabilities: [] } })
  expect(await createService(context).run(saved)).toMatchObject({ error: "workflow_failed" })
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)[0]).toMatchObject({ status: "failed", tool_call_count: 0 })
})

test("runtime-incompatible or invalid input schemas block listing and running without execution", async () => {
  const saved = seed()
  const service = createService(context)
  for (const inputSchema of [
    { type: "object", required: ["callerInput"] }, { type: "object", additionalProperties: false },
    { type: "string" }, { $ref: "unavailable-schema" },
  ]) {
    payload().inputSchema = inputSchema
    const catalog = await service.open({})
    if (catalog.kind !== "workflow_catalog") throw new Error("Expected catalog")
    expect(catalog.workflows[0]?.blockedReason).toContain("input.runtime")
    expect(await service.run(saved)).toMatchObject({ error: "workflow_blocked" })
    witnesses()
  }
})

test("member, read scope and existing workflow feature gates deny before discovery or execution", async () => {
  const saved = seed()
  for (const overrides of [{ member: null }, { scopes: new Set<string>() }, { scopes: new Set(["mcp:write"]) }, { enabled: false }]) {
    const service = createService({ ...context, ...overrides })
    expect(await service.open({})).toMatchObject({ kind: "workflow_error" })
    expect(await service.run(saved)).toMatchObject({ kind: "workflow_error" })
  }
  expect(conditions).toEqual([])
  expect(buildTools).not.toHaveBeenCalled()
  witnesses()
})

test("strict arguments and invalid time zones deny before data access", async () => {
  const saved = seed()
  const service = createService(context)
  for (const extra of [
    { body: {} }, { input: {} }, { runtime: {} }, { code: "return 1" }, { mode: "live" }, { readOnly: false },
    { timeZone: "Invalid/Zone" }, { timeZone: "" }, { configObjectId: "" },
  ]) expect(await service.run({ ...saved, ...extra })).toMatchObject({ error: "invalid_arguments" })
  expect(await service.open({ query: "x".repeat(201) })).toMatchObject({ error: "invalid_arguments" })
  expect(await service.run({ ...saved, configObjectVersionId: "invalid-id" })).toMatchObject({ error: "workflow_unavailable" })
  expect(conditions).toEqual([])
  expect(buildTools).not.toHaveBeenCalled()
  witnesses()
})

test("access revocation, removed members, foreign plugin IDs and newer versions require re-selection", async () => {
  const saved = seed()
  const service = createService(context)
  expect(await service.open({})).toMatchObject({ workflows: [{ configObjectVersionId: saved.configObjectVersionId }] })
  const grants = rows(ConfigObjectAccessGrantTable)
  tables.set(ConfigObjectAccessGrantTable, [])
  expect(await service.run(saved)).toMatchObject({ error: "workflow_unavailable" })
  tables.set(ConfigObjectAccessGrantTable, grants)
  const member = rows(MemberTable)[0]
  if (!member) throw new Error("Expected member")
  member.removedAt = new Date()
  expect(await service.run(saved)).toMatchObject({ error: "workflow_unavailable" })
  member.removedAt = null
  expect(await service.run({ ...saved, pluginId: createDenTypeId("plugin") })).toMatchObject({ error: "workflow_unavailable" })
  expect(await createService({ ...context, organizationId: createDenTypeId("organization") }).run(saved)).toMatchObject({ error: "workflow_unavailable" })
  put(ConfigObjectVersionTable, { ...rows(ConfigObjectVersionTable)[0], id: createDenTypeId("configObjectVersion"), rawSourceText: "return { count: 99 }" })
  expect(await service.run(saved)).toMatchObject({ error: "workflow_unavailable" })
  witnesses()
})

test("rechecks current selection after tool discovery and never substitutes a newer version", async () => {
  const saved = seed()
  const service = createService({ ...context, buildTools: async () => {
    put(ConfigObjectVersionTable, { ...rows(ConfigObjectVersionTable)[0], id: createDenTypeId("configObjectVersion") })
    return buildTools()
  } })
  expect(await service.run(saved)).toMatchObject({ error: "workflow_unavailable" })
  witnesses()
})

test("executor still rechecks member grants after runner preflight", async () => {
  const saved = seed()
  const service = createService(context, {
    list: marketplace.listAccessibleWorkflows,
    execute: async (input) => {
      tables.set(ConfigObjectAccessGrantTable, [])
      return marketplace.executeMarketplaceCapability(input)
    },
  })
  expect(await service.run(saved)).toMatchObject({ error: "workflow_unavailable" })
  witnesses()
})

test("exactVersion excludes deleted versions even when the descriptor payload is retained", async () => {
  const saved = seed({ deleted: true })
  expect(await createService(context).run(saved)).toMatchObject({ error: "workflow_unavailable" })
  expect(conditions.some(({ table, condition }) => table === ConfigObjectVersionTable
    && parameters(condition).includes(saved.configObjectVersionId)
    && parameters(condition).includes(false)
    && contains(condition, ConfigObjectVersionTable.isDeletedVersion))).toBe(true)
  witnesses()
})

test("invalid output and raw script exceptions become safe errors without successful snapshots", async () => {
  const saved = seed()
  toolResult = { count: "invalid" }
  expect(await createService(context).run(saved)).toMatchObject({ error: "workflow_validation_failed" })
  expect(rows(WorkflowRunTable)[0]).toMatchObject({ status: "failed", error_kind: "InvalidResult" })
  const version = rows(ConfigObjectVersionTable)[0]
  if (!version) throw new Error("Expected version")
  version.rawSourceText = 'throw new Error("secret-value")'
  const result = await createService(context).run(saved)
  expect(result).toMatchObject({ error: "workflow_failed" })
  expect(JSON.stringify(result)).not.toContain("secret-value")
  expect(rows(WorkflowRunTable).every((row) => row.status === "failed" && row.validated_result === undefined)).toBe(true)
})

test("discovery exceptions and unavailable tool construction never leak secrets or execute", async () => {
  const saved = seed()
  const service = createService({ ...context, buildTools: async () => { throw new Error("secret-value") } })
  for (const response of [await service.open({}), await service.run(saved)]) {
    expect(response.kind).toBe("workflow_error")
    expect(JSON.stringify(response)).not.toContain("secret-value")
  }
  const failedList = createService(context, {
    list: async () => { throw new Error("secret-value") }, execute: marketplace.executeMarketplaceCapability,
  })
  expect(JSON.stringify(await failedList.open({}))).not.toContain("secret-value")
  witnesses()
})
