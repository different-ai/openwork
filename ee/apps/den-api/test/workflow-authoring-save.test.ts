import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import { Effect } from "effect"
import {
  ConfigObjectTable,
  ConfigObjectVersionTable,
  PluginConfigObjectTable,
  PluginTable,
  WorkflowRunTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest, optionalArtifactDigest } from "../src/workflow-artifacts.js"
import { codemodeCodeDigest } from "../src/workflow-runs.js"
import { retainWorkflowAuthoringSource } from "../src/workflow-authoring-receipts.js"
import type { WorkflowAuthoringSourceInput } from "../src/workflow-authoring-receipts.js"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"
import type { SaveWorkflowInput } from "../src/workflows.js"

type Workflows = typeof import("../src/workflows.js")
type RoleRequest = Parameters<typeof import("../src/routes/org/plugin-system/access.js").requirePluginArchResourceRole>[0]
let workflows: Workflows
let rows: Record<string, unknown>[] = []
let written: Array<{ table: unknown; value: Record<string, unknown> }> = []
let roles: RoleRequest[] = []
let pluginRole: "viewer" | "editor" | "manager" = "manager"
let workflowRole: "viewer" | "editor" | "manager" = "manager"
let existing = false
let toolBuilds = 0
let selects = 0
let pluginId = createDenTypeId("plugin")
let configObjectId = createDenTypeId("configObject")
let organizationId = createDenTypeId("organization")

function selectRows(table: unknown): Record<string, unknown>[] {
  if (table === WorkflowRunTable) return rows
  if (table === PluginTable) return [{ id: pluginId, name: "My Workflows" }]
  if (table === PluginConfigObjectTable) return existing ? [{ object: { id: configObjectId } }] : []
  if (table === ConfigObjectTable) return [{ configObject: { id: configObjectId, organizationId }, plugin: { id: pluginId } }]
  return []
}

const transactionDb = {
  select: () => {
    selects += 1
    return {
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          innerJoin: (_table: unknown, _condition: unknown) => query,
          orderBy: (..._order: unknown[]) => query,
          limit: (_limit: number) => query,
          for: (_lock: string) => Promise.resolve(selectRows(table)),
          then: (resolve: (value: Record<string, unknown>[]) => unknown) => Promise.resolve(selectRows(table)).then(resolve),
        }
        return query
      },
    }
  },
  insert: (table: unknown) => ({ values: async (value: Record<string, unknown>) => { written.push({ table, value }) } }),
}

const database = {
  ...transactionDb,
  transaction: async <T>(run: (tx: typeof transactionDb) => Promise<T>): Promise<T> => run(transactionDb),
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: database }))
  const access = await import("../src/routes/org/plugin-system/access.js")
  mock.module("../src/routes/org/plugin-system/access.js", () => ({
    ...access,
    requirePluginArchResourceRole: async (request: RoleRequest) => {
      roles.push(request)
      const actual = request.resourceKind === "plugin" ? pluginRole : workflowRole
      if ((request.role === "manager" && actual !== "manager") || (request.role === "editor" && actual === "viewer")) {
        throw new Error(`Missing ${request.role} access for ${request.resourceKind}.`)
      }
    },
  }))
  workflows = await import("../src/workflows.js")
})

afterAll(() => mock.restore())
beforeEach(() => {
  rows = []
  written = []
  roles = []
  pluginRole = "manager"
  workflowRole = "manager"
  existing = false
  toolBuilds = 0
  selects = 0
  pluginId = createDenTypeId("plugin")
  configObjectId = createDenTypeId("configObject")
  organizationId = createDenTypeId("organization")
})

async function fixture(options: { mode?: "adhoc" | "live"; currentInput?: unknown; inputSchema?: unknown; outputSchema?: unknown; retain?: boolean } = {}) {
  const orgMembershipId = createDenTypeId("member")
  const now = new Date()
  const runtime = options.mode === "live" ? artifactRuntime("America/Los_Angeles") : undefined
  const code = "  return input;\n"
  const source: WorkflowAuthoringSourceInput = {
    receiptId: createDenTypeId("workflowRun"), organizationId, orgMembershipId,
    code, mode: options.mode ?? "adhoc",
    inputDigest: artifactDigest(runtime ? { runtime } : options.currentInput ?? null),
    inputSchemaDigest: optionalArtifactDigest(options.inputSchema),
    outputSchemaDigest: optionalArtifactDigest(options.outputSchema),
    ...(runtime ? { runtime } : {}),
  }
  if (options.retain !== false) expect(await retainWorkflowAuthoringSource(source)).toBe(true)
  const row: Record<string, unknown> = {
    id: source.receiptId, organization_id: organizationId, org_membership_id: orgMembershipId,
    code_digest: codemodeCodeDigest(code), source: runtime ? "authoring:live" : "adhoc",
    script_input: null, script_input_digest: source.inputDigest,
    input_schema_digest: source.inputSchemaDigest, output_schema_digest: source.outputSchemaDigest,
    config_object_id: null, config_object_version_id: null, plugin_id: null, automation_run_id: null,
    artifact_content_deleted_at: null, status: "succeeded", finished_at: now, tool_calls: [],
    validated_result: null, result_markdown: null,
  }
  rows = [row]
  const workflow: SaveWorkflowInput = {
    name: "Synthetic authoring workflow", receiptId: source.receiptId,
    ...(options.currentInput === undefined ? {} : { currentInput: options.currentInput }),
    ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  }
  const context: PluginArchActorContext = {
    memberTeams: [], session: { createdAt: now },
    organizationContext: {
      organization: {
        id: organizationId, name: "Synthetic Org", slug: organizationId, logo: null, allowedEmailDomains: null,
        metadata: null, createdAt: now, updatedAt: now,
      },
      currentMember: {
        id: orgMembershipId, userId: createDenTypeId("user"), role: "member", directRole: "member", adminTeams: [],
        createdAt: now, joinedAt: now, isOwner: false,
      },
      invitations: [], members: [], roles: [], teams: [],
    },
  }
  const buildTools = async (): Promise<BuiltCodemodeTools> => { toolBuilds += 1; return { tools: {}, manifest: [] } }
  return { source, row, input: { organizationId, ownerMemberId: orgMembershipId, workflow, context, buildTools } }
}

function savedVersion() {
  const version = written.find((entry) => entry.table === ConfigObjectVersionTable)?.value
  if (!version) throw new Error("expected saved version")
  return version
}

test("explicit receipt saves exact retained bytes and tested schemas without snapshot linkage", async () => {
  const { source, input } = await fixture({ currentInput: { count: 1 }, inputSchema: { type: "object" }, outputSchema: { type: "object" } })
  const before = structuredClone(rows)
  await workflows.saveWorkflow(input)
  expect(savedVersion()).toMatchObject({ rawSourceText: source.code, sourceRevisionRef: codemodeCodeDigest(source.code) })
  expect(savedVersion().normalizedPayloadJson).toEqual({
    language: "codemode-js", exampleInput: { count: 1 }, inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredCapabilities: [],
  })
  expect(rows).toEqual(before)
  expect(written.some((entry) => entry.table === WorkflowRunTable)).toBe(false)
})

test("shared-store reads may deserialize new objects without losing strict receipt binding", async () => {
  const { input } = await fixture()
  const authoring = await import("../src/workflow-authoring-receipts.js")
  const originalGet = authoring.getWorkflowAuthoringSource
  const getter = spyOn(authoring, "getWorkflowAuthoringSource").mockImplementation(async (identity) => {
    const result = await originalGet(identity)
    return result ? structuredClone(result) : null
  })
  try {
    await workflows.saveWorkflow(input)
    expect(savedVersion()).toBeDefined()
    expect(getter).toHaveBeenCalledTimes(2)
  } finally {
    getter.mockRestore()
  }
})

test("allows byte-identical supplied code but rejects even whitespace changes", async () => {
  const { source, input } = await fixture()
  await workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, code: source.code } })
  written = []
  await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, code: source.code.trim() } })).rejects.toThrow("workflow_authoring_receipt_required")
  expect(written).toEqual([])
})

test("explicit input digest normalizes omitted input to null, not to an empty object", async () => {
  const { input } = await fixture({ inputSchema: { type: "null" } })
  await workflows.saveWorkflow(input)
  await workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, currentInput: null } })
  await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, currentInput: {} } })).rejects.toThrow("workflow_authoring_receipt_required")
})

test("altered current input or either schema cannot save, including removed schemas", async () => {
  const { input } = await fixture({ currentInput: { count: 1 }, inputSchema: { type: "object" }, outputSchema: { type: "object" } })
  for (const change of [
    { currentInput: { count: 2 } }, { currentInput: undefined },
    { inputSchema: { type: "string" } }, { inputSchema: undefined },
    { outputSchema: { type: "string" } }, { outputSchema: undefined },
  ]) {
    await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, ...change } })).rejects.toThrow("workflow_authoring_receipt_required")
  }
  expect(written).toEqual([])
  expect(toolBuilds).toBe(0)
})

test("new output schema cannot be attached to an unvalidated explicit receipt", async () => {
  const { input } = await fixture()
  await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, outputSchema: { type: "object" } } })).rejects.toThrow("workflow_authoring_receipt_required")
  expect(written).toEqual([])
})

test("live input validation uses retained runtime without persisting day bounds as example input", async () => {
  const { input, source } = await fixture({ mode: "live", inputSchema: {
    type: "object", required: ["runtime"], additionalProperties: false,
    properties: { runtime: { type: "object", required: ["now", "today", "timeZone", "dayStart", "dayEnd"] } },
  } })
  await workflows.saveWorkflow(input)
  expect(savedVersion().normalizedPayloadJson).not.toHaveProperty("exampleInput")
  expect(JSON.stringify(written.map((entry) => entry.value))).not.toContain(source.runtime?.dayStart ?? "missing runtime")
  for (const currentInput of [undefined, null, {}, { runtime: source.runtime }]) {
    await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, currentInput } })).rejects.toThrow("workflow_live_current_input_forbidden")
  }
})

test("save revalidates live dependency authority and executable availability before persistence", async () => {
  for (const state of ["eligible", "write", "external", "unknown", "missing-definition", "missing-manifest", "disabled-definition", "conflicting"] as const) {
    written = []
    const { input, row } = await fixture({ mode: "live" })
    row.tool_calls = [{ name: "den.read" }]
    const definition = Tool.make({ description: "Synthetic read", input: { type: "object" }, run: () => Effect.succeed(2),
      ...(state === "disabled-definition" ? { unavailableReason: "Disabled" } : {}),
    })
    const entry = { scriptPath: "tools.den.read", capabilityName: "read", authority: "den", readOnly: true } as const
    const built: BuiltCodemodeTools = {
      tools: state === "missing-definition" ? {} : { den: { read: definition } },
      manifest: state === "missing-manifest" ? [] : [{
        ...entry,
        ...(state === "write" ? { readOnly: false } : {}),
        ...(state === "external" ? { authority: "external" } : {}),
        ...(state === "unknown" ? { authority: undefined } : {}),
      }],
    }
    if (state === "conflicting") built.manifest.push({ ...entry, readOnly: false })
    const save = workflows.saveWorkflow({ ...input, buildTools: async () => built })
    if (state === "eligible") {
      await save
      expect(savedVersion().normalizedPayloadJson).toMatchObject({ requiredCapabilities: [{ scriptPath: entry.scriptPath, capabilityName: "read" }] })
    } else {
      await expect(save).rejects.toThrow(state.startsWith("missing") || state === "disabled-definition" ? "workflow_capability_unavailable:" : "workflow_live_capability_ineligible:")
      expect(written).toEqual([])
    }
  }
})

test("adhoc save retains interactive external dependencies", async () => {
  const { input, row } = await fixture()
  row.tool_calls = [{ name: "external.read" }]
  await workflows.saveWorkflow({ ...input, buildTools: async () => ({
    tools: { external: { read: Tool.make({ description: "Synthetic external read", input: { type: "object" }, run: () => Effect.succeed(2) }) } },
    manifest: [{ scriptPath: "tools.external.read", capabilityName: "external-read", authority: "external", readOnly: true }],
  }) })
  expect(savedVersion().normalizedPayloadJson).toMatchObject({ requiredCapabilities: [{ scriptPath: "tools.external.read", capabilityName: "external-read" }] })
})

test("save rejects asynchronous input and output schemas before persistence", async () => {
  for (const key of ["inputSchema", "outputSchema"]) {
    for (const schema of [
      { $async: true, type: "object" },
      { type: "object", properties: { child: { $async: true, type: "string" } } },
    ]) {
      const { input, source } = await fixture({ [key]: schema })
      await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_invalid_schema:")
      await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Legacy async", code: source.code, [key]: schema } }))
        .rejects.toThrow("workflow_invalid_schema:")
    }
  }
  expect(written).toEqual([])
})

test("schema validation still rejects incompatible input even if supplied digests match", async () => {
  for (const mode of ["adhoc", "live"] satisfies Array<"adhoc" | "live">) {
    const { input } = await fixture({ mode, inputSchema: { type: "string" } })
    await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_current_input_invalid")
  }
  expect(written).toEqual([])
})

test("missing, expired, malformed and foreign receipt entries fail closed even with supplied source", async () => {
  const { input, source } = await fixture({ retain: false })
  await expect(workflows.saveWorkflow({ ...input, workflow: { ...input.workflow, code: source.code } })).rejects.toThrow("workflow_authoring_receipt_required")
  expect(await retainWorkflowAuthoringSource(source)).toBe(true)
  for (const change of [
    { organizationId: createDenTypeId("organization") },
    { ownerMemberId: createDenTypeId("member") },
    { workflow: { ...input.workflow, receiptId: "invalid" } },
    { workflow: { ...input.workflow, receiptId: createDenTypeId("workflowRun") } },
  ]) {
    await expect(workflows.saveWorkflow({ ...input, ...change })).rejects.toThrow("workflow_authoring_receipt_required")
  }
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 15 * 60_000)
  try {
    await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_authoring_receipt_required")
  } finally {
    clock.mockRestore()
  }
  expect(written).toEqual([])
  expect(selects).toBe(0)
})

test("receipt expiration during capability resolution fails before persistence", async () => {
  const { input } = await fixture()
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    await expect(workflows.saveWorkflow({
      ...input,
      buildTools: async () => {
        clock.mockReturnValue(now + 15 * 60_000)
        return { tools: {}, manifest: [] }
      },
    })).rejects.toThrow("workflow_authoring_receipt_required")
  } finally {
    clock.mockRestore()
  }
  expect(written).toEqual([])
})

test("durable row must bind exact identity, provenance, digests, success and freshness", async () => {
  const mutations: Record<string, unknown>[] = [
    { id: createDenTypeId("workflowRun") },
    { organization_id: createDenTypeId("organization") }, { org_membership_id: createDenTypeId("member") },
    { source: "mcp" }, { source: "authoring:live" }, { source: "plugin:synthetic" },
    { code_digest: codemodeCodeDigest("return 'altered'") },
    { script_input_digest: artifactDigest({ changed: true }) },
    { input_schema_digest: artifactDigest({ type: "number" }) }, { output_schema_digest: artifactDigest({ type: "number" }) },
    { status: "failed" }, { status: "failed", error_kind: "output_schema_mismatch" },
    { finished_at: new Date(Date.now() - 15 * 60_000) }, { finished_at: new Date(Date.now() + 60_000) },
    { script_input: {} }, { config_object_id: createDenTypeId("configObject") },
    { config_object_version_id: createDenTypeId("configObjectVersion") }, { plugin_id: createDenTypeId("plugin") },
    { automation_run_id: createDenTypeId("automationRun") }, { artifact_content_deleted_at: new Date() },
  ]
  for (const mutation of mutations) {
    const { input, row } = await fixture()
    Object.assign(row, mutation)
    await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_authoring_receipt_required")
  }
  const { input } = await fixture()
  rows = []
  await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_authoring_receipt_required")
  expect(written).toEqual([])
  expect(toolBuilds).toBe(0)
})

test("without receiptId the legacy byte-code lookup remains available without retention", async () => {
  const { input, source, row } = await fixture({ retain: false })
  row.source = "mcp"
  await workflows.saveWorkflow({ ...input, workflow: { name: "Legacy", code: source.code, outputSchema: { type: "object" } } })
  expect(savedVersion().rawSourceText).toBe(source.code)
  rows = []
  await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Legacy", code: source.code } })).rejects.toThrow("workflow_recent_receipt_required")
  await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Empty" } })).rejects.toThrow("workflow_code_or_receipt_required")
})

test("code-only saves cannot promote live receipts with changed or omitted input and schemas", async () => {
  for (const retain of [true, false]) {
    const { input, source } = await fixture({ mode: "live", retain, inputSchema: { type: "object" }, outputSchema: { type: "object" } })
    for (const contract of [
      {},
      { currentInput: { injected: true } },
      { currentInput: { runtime: source.runtime } },
      { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
      { inputSchema: { type: "string" }, outputSchema: { type: "number" } },
    ]) {
      await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Legacy live", code: source.code, ...contract } }))
        .rejects.toThrow("workflow_authoring_receipt_required")
    }
  }
  expect(written).toEqual([])
  expect(toolBuilds).toBe(0)
})

for (const code of [
  'const apiKey = ("synthetic-literal-credential"); return null',
  'const apiKey = ("synthetic-literal-credential" + ""); return null',
  'const apiKey = ("" + "synthetic-literal-credential"); return null',
  'const apiKey /* name */ = /* value */ ("synthetic-literal-credential"); return null',
  'return { apiKey: /* value */ ("synthetic-literal-credential") }',
  'const headers = {}; headers["apiKey"] = ("synthetic-literal-credential"); return headers',
]) {
  test(`save rejects wrapped or comment-separated credentials: ${code}`, async () => {
    const { input } = await fixture()
    await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Secret", code } })).rejects.toThrow(/^workflow_source_contains_secret$/)
    expect(written).toEqual([])
    expect(toolBuilds).toBe(0)
  })
}

test("save allows parenthesized parameter references without treating them as credentials", async () => {
  const { input, row } = await fixture({ retain: false })
  const code = "const apiKey = /* parameter */ (input.apiKey); return { apiKey }"
  row.code_digest = codemodeCodeDigest(code)
  await workflows.saveWorkflow({ ...input, workflow: { name: "Parameterized", code, currentInput: { apiKey: "synthetic-runtime-value" } } })
  expect(savedVersion().rawSourceText).toBe(code)
})

test("secret source is denied on both save functions with a generic error before writes", async () => {
  const { input } = await fixture()
  const code = 'return { apiKey: "synthetic-literal-credential" }'
  await expect(workflows.saveWorkflow({ ...input, workflow: { name: "Secret", code } })).rejects.toThrow(/^workflow_source_contains_secret$/)
  await expect(workflows.createWorkflowVersion({
    context: input.context, configObjectId, receiptId: input.workflow.receiptId ?? "",
    draft: { name: "Secret", code, requiredCapabilities: [] }, buildTools: input.buildTools,
  })).rejects.toThrow(/^workflow_source_contains_secret$/)
  expect(written).toEqual([])
  expect(toolBuilds).toBe(0)
})

test("chosen plugin still requires editor and matching actor context", async () => {
  const { input } = await fixture()
  input.workflow.pluginId = pluginId
  pluginRole = "viewer"
  await expect(workflows.saveWorkflow(input)).rejects.toThrow("Missing editor access for plugin.")
  expect(roles.at(-1)).toMatchObject({ role: "editor", resourceKind: "plugin", resourceId: pluginId })
  pluginRole = "editor"
  await workflows.saveWorkflow(input)
  expect(savedVersion()).toBeDefined()
  await expect(workflows.saveWorkflow({ ...input, context: undefined })).rejects.toThrow("saved_workflow_plugin_context_required")
  await expect(workflows.saveWorkflow({ ...input, organizationId: createDenTypeId("organization") })).rejects.toThrow("saved_workflow_plugin_context_required")
})

test("same-name replacement and version route retain the workflow manager guard", async () => {
  const { input, source } = await fixture()
  input.workflow.pluginId = pluginId
  pluginRole = "editor"
  workflowRole = "editor"
  existing = true
  await expect(workflows.saveWorkflow(input)).rejects.toThrow("Missing manager access for config_object.")
  expect(roles.at(-1)).toMatchObject({ role: "manager", resourceKind: "config_object", resourceId: configObjectId })
  await expect(workflows.createWorkflowVersion({
    context: input.context, configObjectId, receiptId: source.receiptId,
    draft: { name: "Replacement", code: source.code, requiredCapabilities: [] }, buildTools: input.buildTools,
  })).rejects.toThrow("Missing manager access for config_object.")
  expect(written).toEqual([])
  workflowRole = "manager"
  await workflows.saveWorkflow(input)
  expect(savedVersion().rawSourceText).toBe(source.code)
})

test("a tested capability must still be available in the caller's current tool tree", async () => {
  const { input, row } = await fixture()
  row.tool_calls = [{ name: "tools.den.syntheticRead" }]
  await expect(workflows.saveWorkflow(input)).rejects.toThrow("workflow_capability_unavailable:tools.den.syntheticRead")
  expect(written).toEqual([])
})
