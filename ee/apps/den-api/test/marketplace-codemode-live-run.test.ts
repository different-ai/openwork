import { afterAll, beforeAll, beforeEach, expect, mock, setSystemTime, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import {
  ArtifactViewRevisionTable, ArtifactViewTable, ConfigObjectAccessGrantTable,
  ConfigObjectTable, ConfigObjectVersionTable, MemberTable, PluginTable, WorkflowRunTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import { Hono, type MiddlewareHandler } from "hono"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest } from "../src/workflow-artifacts.js"
import { recordWorkflowRun } from "../src/workflow-runs.js"
import { createWorkflowAuthoringSourceStore } from "../src/workflow-authoring-receipts.js"
import * as validation from "../src/middleware/validation.js"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

type Row = Record<string, unknown>
type Marketplace = typeof import("../src/mcp/marketplace-capabilities.js")
let marketplace: Marketplace
let db: typeof import("../src/db.js")["db"]
let workflows: typeof import("../src/workflows.js")
let authoring: typeof import("../src/mcp/workflow-authoring-test.js")
let artifactViews: typeof import("../src/artifact-views.js")
let app: Hono<{ Variables: OrgRouteVariables }>
let context: PluginArchActorContext
let store = createWorkflowAuthoringSourceStore({ redis: null })
const tables = new Map<unknown, Row[]>()
const queries: Array<{ table: unknown; values: unknown[] }> = []
const calls: Array<{ name: string; input: unknown }> = []
let toolResult: unknown = { count: 2 }
let manifest: BuiltCodemodeTools["manifest"] = []
const buildTools = mock(async (): Promise<BuiltCodemodeTools> => ({
  tools: { den: { read: definition("read"), write: definition("write") } }, manifest,
}))

function definition(name: string) {
  return Tool.make({
    description: `Synthetic ${name}`, input: { type: "object" },
    run: (input) => Effect.sync(() => { calls.push({ name, input }); return toolResult }),
  })
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Row {
  if (!isRecord(value)) throw new Error("Expected object")
  return value
}

function rows(table: unknown) { return tables.get(table) ?? [] }

function parameters(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return []
  if ("value" in value && "encoder" in value) return [value.value]
  if ("queryChunks" in value && Array.isArray(value.queryChunks)) return value.queryChunks.flatMap(parameters)
  return []
}

function put(table: unknown, value: Row) {
  const now = new Date()
  tables.set(table, [...rows(table), { createdAt: now, created_at: now, updated_at: now, artifact_content_deleted_at: null, ...value }])
}

const transactionDb = {
  select: (projection?: Row) => ({ from: (table: unknown) => {
    let values: unknown[] = []
    let descending = false
    let maximum = Infinity
    const selected = () => {
      let result = [...rows(table)]
      const identityFields: Array<[string, string]> = [
        ["cov_", "id"], ["wfr_", "id"], ["arv_", table === ArtifactViewRevisionTable ? "artifact_view_id" : "id"],
        ["cob_", table === ConfigObjectTable ? "id" : table === ConfigObjectVersionTable || table === ConfigObjectAccessGrantTable ? "configObjectId" : "config_object_id"],
      ]
      for (const [prefix, field] of identityFields) {
        const id = values.find((value) => typeof value === "string" && value.startsWith(prefix))
        if (id !== undefined && field) result = result.filter((row) => row[field] === id)
      }
      if (descending) result.reverse()
      result = result.slice(0, maximum)
      if (table === ConfigObjectTable) return result.map((configObject) => ({ configObject, plugin: rows(PluginTable)[0], marketplace: null }))
      if (table === ConfigObjectAccessGrantTable) return result.map((row) => ({ ...row, resourceId: row.configObjectId }))
      if (table === WorkflowRunTable && projection?.receipt) return result.map((receipt) => ({ receipt, automationTrigger: null }))
      return result
    }
    const query = {
      where: (condition: unknown) => { values = parameters(condition); queries.push({ table, values }); return query },
      innerJoin: (_table: unknown, _condition: unknown) => query,
      leftJoin: (_table: unknown, _condition: unknown) => query,
      orderBy: (..._order: unknown[]) => { descending = true; return query },
      limit: (limit: number) => { maximum = limit; return query },
      for: (_lock: string) => query,
      then: (resolve: (result: Row[]) => unknown) => Promise.resolve(selected()).then(resolve),
    }
    return query
  } }),
  insert: (table: unknown) => ({ values: async (value: Row) => { put(table, value) } }),
}
const database = {
  ...transactionDb,
  transaction: async <T>(run: (tx: typeof transactionDb) => Promise<T>): Promise<T> => run(transactionDb),
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: database }))
  db = (await import("../src/db.js")).db
  const access = await import("../src/routes/org/plugin-system/access.js")
  mock.module("../src/routes/org/plugin-system/access.js", () => ({
    ...access, requirePluginArchResourceRole: async () => {}, resolvePluginArchResourceRole: async () => "manager",
  }))
  const retention = await import("../src/workflow-authoring-receipts.js")
  mock.module("../src/workflow-authoring-receipts.js", () => ({
    ...retention, getWorkflowAuthoringSource: (input: Parameters<typeof store.get>[0]) => store.get(input),
  }))
  const memberRoute: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    c.set("organizationContext", context.organizationContext)
    c.set("session", null)
    await next()
  }
  mock.module("../src/mcp/auth.js", () => ({ getMcpResourceContext: () => ({}), verifyMcpRequest: async () => null }))
  const middleware = await import("../src/middleware/index.js")
  mock.module("../src/middleware/index.js", () => ({ ...middleware, ...validation, orgMemberRoute: () => memberRoute }))
  const orgs = await import("../src/orgs.js")
  mock.module("../src/orgs.js", () => ({ ...orgs, listTeamsForMember: async () => [] }))
  mock.module("../src/mcp/index.js", () => ({ getCatalog: async () => [] }))
  mock.module("../src/mcp/capability-registry.js", () => ({
    createCapabilityRegistryContext: () => ({}), buildCapabilityToolTree: buildTools,
    liveArtifactConnectionFailure: async () => null,
  }))
  marketplace = await import("../src/mcp/marketplace-capabilities.js")
  workflows = await import("../src/workflows.js")
  authoring = await import("../src/mcp/workflow-authoring-test.js")
  artifactViews = await import("../src/artifact-views.js")
  const { registerOrgWorkflowRoutes } = await import("../src/routes/org/codemode-scripts.js")
  app = new Hono<{ Variables: OrgRouteVariables }>()
  registerOrgWorkflowRoutes(app)
})

afterAll(() => mock.restore())
beforeEach(() => {
  tables.clear()
  queries.length = 0
  calls.length = 0
  buildTools.mockClear()
  store = createWorkflowAuthoringSourceStore({ redis: null })
  toolResult = { count: 2 }
  manifest = [
    { capabilityName: "read", scriptPath: "tools.den.read", authority: "den", readOnly: true },
    { capabilityName: "write", scriptPath: "tools.den.write", authority: "den", readOnly: false },
  ]
  const now = new Date()
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  context = {
    memberTeams: [], session: { createdAt: now }, organizationContext: {
      organization: { id: organizationId, name: "ENG-113 fixture", slug: organizationId, logo: null,
        allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
      currentMember: { id: memberId, userId: createDenTypeId("user"), role: "member", directRole: "member", adminTeams: [],
        createdAt: now, joinedAt: now, isOwner: false },
      invitations: [], members: [], roles: [], teams: [],
    },
  }
  put(MemberTable, { id: memberId, role: "member" })
  put(PluginTable, { id: createDenTypeId("plugin"), name: "My Workflows", organizationId })
})

const runtimeSchema = {
  type: "object", additionalProperties: false, required: ["runtime"], properties: {
    runtime: { type: "object", additionalProperties: false, required: ["now", "today", "timeZone", "dayStart", "dayEnd"],
      properties: Object.fromEntries(["now", "today", "timeZone", "dayStart", "dayEnd"].map((key) => [key, { type: "string" }])) },
  },
}
const outputSchema = { type: "object", additionalProperties: false, required: ["count"], properties: { count: { type: "number" } } }
const code = "return await tools.den.read(input.runtime)"

function seed(codeValue = code, payload: Row = {}) {
  const configObjectId = createDenTypeId("configObject")
  const configObjectVersionId = createDenTypeId("configObjectVersion")
  const organizationId = context.organizationContext.organization.id
  put(ConfigObjectTable, { id: configObjectId, organizationId, objectType: "workflow", title: "ENG-113 fixture", description: null })
  put(ConfigObjectVersionTable, { id: configObjectVersionId, configObjectId, organizationId, rawSourceText: codeValue,
    normalizedPayloadJson: { language: "codemode-js", outputSchema, requiredCapabilities: [{ capabilityName: "read", scriptPath: "tools.den.read" }], ...payload } })
  put(ConfigObjectAccessGrantTable, { configObjectId, orgMembershipId: context.organizationContext.currentMember.id, role: "manager", removedAt: null })
  return { configObjectId, configObjectVersionId, pluginId: String(rows(PluginTable)[0]?.id) }
}

function execute(saved: ReturnType<typeof seed>, options: Partial<Parameters<Marketplace["executeMarketplaceCapability"]>[0]> = {}) {
  return marketplace.executeMarketplaceCapability({ ...saved, organizationId: context.organizationContext.organization.id,
    member: { orgMembershipId: context.organizationContext.currentMember.id, teamIds: [] }, buildTools, ...options })
}

async function request(path: string, body: Row) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

function savedResponse(value: unknown) {
  const result = record(value)
  return {
    pluginId: normalizeDenTypeId("plugin", String(result.pluginId)),
    configObjectId: normalizeDenTypeId("configObject", String(result.configObjectId)),
    configObjectVersionId: normalizeDenTypeId("configObjectVersion", String(result.configObjectVersionId)),
  }
}

test("live authoring -> receipt-only save -> exact saved live run -> validated snapshot -> artifact build", async () => {
  const timeZone = "America/Los_Angeles"
  const tested = await authoring.executeWorkflowAuthoringTest({ mode: "live", timeZone, code, inputSchema: runtimeSchema, outputSchema }, {
    organizationId: context.organizationContext.organization.id, orgMembershipId: context.organizationContext.currentMember.id,
    buildTools, retainSource: store.retain, retentionMetadata: async () => store.metadata(),
    recordRun: (input) => recordWorkflowRun(db, input),
  })
  expect(tested.isError).not.toBe(true)
  const metadata = record(record(tested.structuredContent).metadata)
  const authoringReceipt = structuredClone(rows(WorkflowRunTable)[0])
  expect(metadata).toMatchObject({ mode: "live", executionType: "authoring-test", verification: "schema", timeZone,
    retention: { canSaveByReceipt: true } })
  expect(authoringReceipt).toMatchObject({ id: metadata.receiptId, source: "authoring:live", status: "succeeded",
    plugin_id: null, config_object_id: null, config_object_version_id: null, script_input: null, result_markdown: null })
  expect(authoringReceipt?.validated_result).toBeUndefined()
  const response = await request("/v1/workflows", { name: "ENG-113 live authoring", receiptId: metadata.receiptId,
    inputSchema: runtimeSchema, outputSchema })
  expect(response.status).toBe(201)
  const saved = savedResponse(await response.json())
  expect(rows(ConfigObjectVersionTable)[0]).toMatchObject({ id: saved.configObjectVersionId, rawSourceText: code,
    normalizedPayloadJson: { inputSchema: runtimeSchema, outputSchema, requiredCapabilities: [{ capabilityName: "read", scriptPath: "tools.den.read" }] } })
  expect(record(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson)).not.toHaveProperty("exampleInput")
  expect(rows(WorkflowRunTable)).toEqual([authoringReceipt])
  expect((await workflows.getWorkflowDetail({ context, configObjectId: saved.configObjectId })).latestSuccessfulSnapshot).toBeNull()
  store = createWorkflowAuthoringSourceStore({ redis: null })
  toolResult = { count: 3 }
  const run = await request(`/v1/workflows/${saved.configObjectId}/run`, { pluginId: saved.pluginId,
    configObjectVersionId: saved.configObjectVersionId, mode: "live", timeZone })
  expect(run.status).toBe(200)
  const result = record(await run.json())
  expect(result).toMatchObject({ status: "succeeded", executionType: "saved-workflow", mode: "live", timeZone,
    value: { count: 3 }, resultDigest: artifactDigest({ count: 3 }), inputSchemaDigest: artifactDigest(runtimeSchema),
    outputSchemaDigest: artifactDigest(outputSchema), rendererVersion: "codemode-markdown-v1" })
  expect(result.receiptId).not.toBe(metadata.receiptId)
  expect(calls).toHaveLength(2)
  for (const call of calls) {
    const runtime = record(call.input)
    expect(runtime).toEqual(artifactRuntime(timeZone, new Date(String(runtime.now))))
  }
  expect(rows(WorkflowRunTable)[0]).toEqual(authoringReceipt)
  expect(rows(WorkflowRunTable)[1]).toMatchObject({ id: result.receiptId, plugin_id: saved.pluginId,
    organization_id: context.organizationContext.organization.id, org_membership_id: context.organizationContext.currentMember.id,
    config_object_id: saved.configObjectId, config_object_version_id: saved.configObjectVersionId,
    source: `live:plugin:${saved.pluginId}:${saved.configObjectId}`, validated_result: { count: 3 },
    output_schema_digest: artifactDigest(outputSchema), script_input: null,
    script_input_digest: artifactDigest({ runtime: calls[1]?.input }), status: "succeeded" })
  const detail = await workflows.getWorkflowDetail({ context, configObjectId: saved.configObjectId })
  expect(detail.latestSuccessfulSnapshot).toMatchObject({ receiptId: result.receiptId, configObjectVersionId: saved.configObjectVersionId,
    value: { count: 3 }, markdown: result.markdown, outputSchemaDigest: artifactDigest(outputSchema) })
  const view = await artifactViews.saveArtifactViewRevision({ context, configObjectId: saved.configObjectId,
    title: "ENG-113 live authoring", reactSource: "export default function View({ data }) { return <div>{data.count}</div> }" })
  expect(view).toMatchObject({ configObjectId: saved.configObjectId, dataMode: "live", activeRevisionId: null })
  expect(view.revisions[0]).toMatchObject({ buildStatus: "ready", outputSchemaDigest: artifactDigest(outputSchema) })
  expect(calls).toHaveLength(2)
})

test("live saved runs generate fresh runtime, default UTC, and validate without an explicit validation flag", async () => {
  const saved = seed("return input", { inputSchema: runtimeSchema, outputSchema: runtimeSchema, requiredCapabilities: [] })
  for (const timeZone of [undefined, "Asia/Kolkata"]) {
    const before = Date.now()
    const result = await execute(saved, { liveRuntime: { timeZone }, validateScriptOutput: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const runtime = record(record(result.result.value).runtime)
    expect(Date.parse(String(runtime.now))).toBeGreaterThanOrEqual(before)
    expect(Date.parse(String(runtime.now))).toBeLessThanOrEqual(Date.now())
    expect(result.result.value).toEqual({ runtime: artifactRuntime(timeZone, new Date(String(runtime.now))) })
    expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ validated_result: result.result.value, output_schema_digest: artifactDigest(runtimeSchema) })
  }
  expect(new Set(rows(WorkflowRunTable).map((row) => row.id)).size).toBe(2)
})

test("opening a live app regenerates calendar bounds across Los Angeles midnight and fall-back", async () => {
  const saved = seed(code, { inputSchema: runtimeSchema, exampleInput: { runtime: { today: "2000-01-01" } } })
  const savedPayload = structuredClone(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson)
  const timeZone = "America/Los_Angeles"
  try {
    for (const [now, today, dayStart, dayEnd] of [
      ["2026-11-01T06:59:59.999Z", "2026-10-31", "2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z"],
      ["2026-11-01T07:00:00.000Z", "2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
      ["2026-11-01T08:30:00.000Z", "2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
      ["2026-11-01T09:30:00.000Z", "2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
      ["2026-11-02T08:00:00.000Z", "2026-11-02", "2026-11-02T08:00:00.000Z", "2026-11-03T08:00:00.000Z"],
    ]) {
      setSystemTime(new Date(now))
      const result = await workflows.executeLiveArtifactWorkflow({
        context, configObjectId: saved.configObjectId, expectedOutputSchemaDigest: artifactDigest(outputSchema), timeZone, buildTools,
      })
      expect(result).toMatchObject({ ok: true, value: { count: 2 } })
      expect(calls.at(-1)).toEqual({ name: "read", input: { now, today, dayStart, dayEnd, timeZone } })
      expect(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson).toEqual(savedPayload)
    }
    expect(calls).toHaveLength(5)
    expect(new Set(rows(WorkflowRunTable).map(row => row.id)).size).toBe(5)
  } finally { setSystemTime() }
})

test("exact saved version is executed rather than a newer version or retained authoring source", async () => {
  const saved = seed("return { count: 1 }", { requiredCapabilities: [] })
  put(ConfigObjectVersionTable, { ...rows(ConfigObjectVersionTable)[0], id: createDenTypeId("configObjectVersion"), rawSourceText: "return { count: 99 }" })
  const pinned = await execute(saved, { liveRuntime: {} })
  expect(pinned).toMatchObject({ ok: true, result: { value: { count: 1 } } })
  expect(queries.some((query) => query.table === ConfigObjectVersionTable && query.values.includes(saved.configObjectVersionId))).toBe(true)
  expect(rows(WorkflowRunTable)[0]?.config_object_version_id).toBe(saved.configObjectVersionId)
  expect(await execute(saved, { configObjectVersionId: undefined, liveRuntime: {} })).toMatchObject({ ok: true, result: { value: { count: 99 } } })
  expect(await execute(saved, { configObjectVersionId: createDenTypeId("configObjectVersion"), liveRuntime: {} }))
    .toMatchObject({ ok: true, result: { status: "content_not_synced" } })
  expect(rows(WorkflowRunTable)).toHaveLength(2)
})

test("live denies writes and external read-only hints; adhoc retains explicit write authority", async () => {
  const saved = seed("return await tools.den.write({})", { requiredCapabilities: [{ capabilityName: "write", scriptPath: "tools.den.write" }] })
  for (const entry of [
    { capabilityName: "write", scriptPath: "tools.den.write", authority: "den", readOnly: false },
    { capabilityName: "write", scriptPath: "tools.den.write", authority: "external", readOnly: true },
    { capabilityName: "write", scriptPath: "tools.den.write", readOnly: true },
  ] satisfies BuiltCodemodeTools["manifest"]) {
    manifest = [entry]
    expect(await execute(saved, { liveRuntime: {} })).toMatchObject({ ok: false, error: "capability_unavailable", providerCallAttempted: false })
    expect(calls).toEqual([])
    expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ status: "failed", source: `live:plugin:${saved.pluginId}:${saved.configObjectId}`, validated_result: undefined })
  }
  expect(await execute(saved, { body: {}, validateScriptOutput: true })).toMatchObject({ ok: true, result: { value: { count: 2 } } })
  expect(calls.map((call) => call.name)).toEqual(["write"])
  expect(rows(WorkflowRunTable).at(-1)?.source).toBe(`plugin:${saved.pluginId}:${saved.configObjectId}`)
})

test("forged live body and invalid time zones fail before storage, tool construction, or provider calls", async () => {
  const saved = seed()
  for (const body of [null, {}, "{}", "", 0, false, [], { runtime: { now: "forged", timeZone: "UTC" } }]) {
    expect(await execute(saved, { liveRuntime: {}, body })).toMatchObject({ ok: false, error: "invalid_capability_arguments", sameArgumentsRetryable: false })
  }
  for (const timeZone of ["Not/A_Zone", "", " ", "x".repeat(101)]) {
    expect(await execute(saved, { liveRuntime: { timeZone } })).toMatchObject({ ok: false, error: "invalid_capability_arguments" })
  }
  const forged = { timeZone: "UTC", runtime: { now: "forged" } }
  expect(await execute(saved, { liveRuntime: forged })).toMatchObject({ ok: false, error: "invalid_capability_arguments" })
  expect(queries).toEqual([])
  expect(buildTools).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)).toEqual([])
})

test("live validates server input before dispatch and rejects output mismatch without a successful snapshot", async () => {
  const saved = seed(code, { inputSchema: { type: "string" } })
  expect(await execute(saved, { liveRuntime: {} })).toMatchObject({ ok: false, error: "invalid_capability_arguments" })
  expect(buildTools).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)[0]).toMatchObject({ status: "failed", error_kind: "InvalidArguments", validated_result: undefined })
  record(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson).inputSchema = runtimeSchema
  toolResult = { count: "wrong" }
  expect(await execute(saved, { liveRuntime: {}, validateScriptOutput: false })).toMatchObject({ ok: false, error: "invalid_capability_arguments" })
  expect(calls).toHaveLength(1)
  expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ status: "failed", error_kind: "InvalidResult", validated_result: undefined,
    result_markdown: null, result_digest: artifactDigest(toolResult), output_schema_digest: artifactDigest(outputSchema) })
  expect((await workflows.getWorkflowDetail({ context, configObjectId: saved.configObjectId })).latestSuccessfulSnapshot).toBeNull()
})

test("run route rejects forged input, invalid time zones, adhoc time zones, and unsupported modes before execution", async () => {
  const saved = seed()
  for (const options of [
    ...[null, {}, [], "{}", 0, false, { runtime: { now: "forged" } }].map((input) => ({ mode: "live", input })),
    { mode: "live", timeZone: "Not/A_Zone" }, { mode: "live", timeZone: "" }, { mode: "live", timeZone: null },
    { timeZone: "UTC" }, { mode: "adhoc", timeZone: "UTC" }, { mode: "snapshot" },
  ]) {
    const result = await request(`/v1/workflows/${saved.configObjectId}/run`, { pluginId: saved.pluginId, configObjectVersionId: saved.configObjectVersionId, ...options })
    expect(result.status).toBe(400)
    expect(await result.json()).toMatchObject({ error: "invalid_request" })
  }
  expect(queries).toEqual([])
  expect(buildTools).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)).toEqual([])
})

test("run route defaults to adhoc and preserves caller input and non-live receipt provenance", async () => {
  const saved = seed("return input", { requiredCapabilities: [] })
  const response = await request(`/v1/workflows/${saved.configObjectId}/run`, { pluginId: saved.pluginId,
    configObjectVersionId: saved.configObjectVersionId, input: { count: 7 } })
  expect(response.status).toBe(200)
  const result = record(await response.json())
  expect(result).toMatchObject({ mode: "adhoc", executionType: "saved-workflow", value: { count: 7 } })
  expect(result).not.toHaveProperty("timeZone")
  expect(rows(WorkflowRunTable)[0]).toMatchObject({ source: `plugin:${saved.pluginId}:${saved.configObjectId}`,
    script_input_digest: artifactDigest({ count: 7 }), validated_result: { count: 7 } })
})

test("legacy marketplace execution still skips output validation unless explicitly requested", async () => {
  const saved = seed("return { count: 'legacy' }", { requiredCapabilities: [] })
  expect(await execute(saved)).toMatchObject({ ok: true, result: { value: { count: "legacy" } } })
  expect(rows(WorkflowRunTable)[0]).toMatchObject({ status: "succeeded", validated_result: undefined, result_markdown: null })
  expect(await execute(saved, { validateScriptOutput: true })).toMatchObject({ ok: false, error: "invalid_capability_arguments" })
  expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ status: "failed", error_kind: "InvalidResult" })
})

test("artifact building retains schema-only prerequisites and live/snapshot data-mode safeguards", async () => {
  const saved = seed()
  const draft = { context, configObjectId: saved.configObjectId, title: "ENG-113 schema prerequisite",
    reactSource: "export default function View({ data }) { return <div>{data.count}</div> }" }
  const payload = record(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson)
  delete payload.outputSchema
  await expect(artifactViews.saveArtifactViewRevision(draft)).rejects.toThrow("artifact_view_output_schema_required")
  expect(rows(ArtifactViewTable)).toEqual([])
  expect(rows(ArtifactViewRevisionTable)).toEqual([])
  payload.outputSchema = outputSchema
  expect(rows(WorkflowRunTable)).toEqual([])
  const view = await artifactViews.saveArtifactViewRevision(draft)
  expect(view).toMatchObject({ dataMode: "live", activeRevisionId: null })
  expect(view.revisions[0]?.buildStatus).toBe("ready")
  await expect(artifactViews.saveArtifactViewRevision({ ...draft, dataMode: "snapshot" })).rejects.toThrow("artifact_view_snapshot_personal_data_denied")
  await expect(artifactViews.saveArtifactViewRevision({ ...draft, artifactViewId: view.id, dataMode: "snapshot" }))
    .rejects.toThrow("artifact_view_data_mode_immutable")
  expect(rows(ArtifactViewTable)).toHaveLength(1)
  expect(rows(ArtifactViewRevisionTable)).toHaveLength(1)
  expect(buildTools).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(rows(WorkflowRunTable)).toEqual([])
})

test("run route returns UTC for omitted live timezone and schema failures as 400", async () => {
  const saved = seed("return input", { requiredCapabilities: [], outputSchema: runtimeSchema })
  const body = { pluginId: saved.pluginId, configObjectVersionId: saved.configObjectVersionId, mode: "live" }
  const response = await request(`/v1/workflows/${saved.configObjectId}/run`, body)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ mode: "live", timeZone: "UTC", value: { runtime: { timeZone: "UTC" } } })
  record(rows(ConfigObjectVersionTable)[0]?.normalizedPayloadJson).outputSchema = outputSchema
  const failed = await request(`/v1/workflows/${saved.configObjectId}/run`, body)
  expect(failed.status).toBe(400)
  expect(await failed.json()).toMatchObject({ error: "invalid_capability_arguments" })
  expect(rows(WorkflowRunTable).at(-1)).toMatchObject({ status: "failed", error_kind: "InvalidResult", validated_result: undefined })
})
