import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Tool, toolError } from "@openwork/codemode"
import { Effect } from "effect"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"
import { artifactRuntime } from "../src/artifact-runtime.js"

let executeWorkflow: typeof import("../src/mcp/workflow-service.js").executeWorkflow

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  executeWorkflow = (await import("../src/mcp/workflow-service.js")).executeWorkflow
})

afterAll(() => mock.restore())

function fixture() {
  const receipts: Record<string, unknown>[] = []
  const database = {
    insert: () => ({ values: async (row: Record<string, unknown>) => { receipts.push(row) } }),
  } as unknown as Parameters<typeof executeWorkflow>[0]["database"]
  return {
    receipts,
    input: {
      database,
      organizationId: createDenTypeId("organization"),
      orgMembershipId: createDenTypeId("member"),
      pluginId: createDenTypeId("plugin"),
      configObjectId: createDenTypeId("configObject"),
      configObjectVersionId: createDenTypeId("configObjectVersion"),
      code: "return await tools.den.read({});",
      normalizedPayloadJson: {
        language: "codemode-js", outputSchema: { type: "object" },
        requiredCapabilities: [{ capabilityName: "read", scriptPath: "tools.den.read" }],
      },
      readOnly: true,
      validateOutput: true,
    },
  }
}

function built(run: () => Effect.Effect<{ actor: string }>, readOnly = true): BuiltCodemodeTools {
  return {
    tools: { den: { read: Tool.make({ description: "Read caller data", input: { type: "object" }, run }) } },
    manifest: [{ capabilityName: "read", scriptPath: "tools.den.read", readOnly, authority: "den" }],
  }
}

test("live execution binds receipts and fetched results to each caller and fetches every time", async () => {
  const { input, receipts } = fixture()
  let calls = 0
  const before = Date.now()
  for (const actor of ["actor-one", "actor-two", "actor-one"]) {
    const member = createDenTypeId("member")
    const result = await executeWorkflow({
      ...input, orgMembershipId: member, scriptInput: { runtime: artifactRuntime("UTC") },
      buildTools: async () => built(() => { calls += 1; return Effect.succeed({ actor }) }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.value).toEqual({ actor })
    expect(receipts.at(-1)).toMatchObject({ org_membership_id: member, validated_result: { actor }, script_input: null })
  }
  expect(calls).toBe(3)
  expect(new Set(receipts.map((row) => row.id)).size).toBe(3)
  for (const receipt of receipts) {
    expect(receipt.finished_at).toBeInstanceOf(Date)
    expect(Number(receipt.finished_at)).toBeGreaterThanOrEqual(before)
  }
})

test("execution boundary denies writes, forged hints, missing pairs and missing connections before calls", async () => {
  const { input } = fixture()
  let calls = 0
  const make = () => { calls += 1; return Effect.succeed({ actor: "unexpected" }) }
  const tools = built(make)
  for (const candidate of [
    built(make, false),
    { ...tools, manifest: [{ capabilityName: "read", scriptPath: "tools.den.read", readOnly: true }] },
    { ...tools, manifest: [{ capabilityName: "different", scriptPath: "tools.den.read", readOnly: true, authority: "den" }] } satisfies BuiltCodemodeTools,
    { tools: {}, manifest: [] },
  ]) {
    const result = await executeWorkflow({ ...input, buildTools: async () => candidate })
    expect(result).toMatchObject({ ok: false, error: "capability_unavailable", providerCallAttempted: false })
  }
  expect(calls).toBe(0)
})

test("normal explicit runs retain write authority while Automations and live runs deny writes", async () => {
  const { input } = fixture()
  const buildTools = async () => built(() => Effect.succeed({ actor: "caller" }), false)
  expect((await executeWorkflow({ ...input, readOnly: false, buildTools })).ok).toBe(true)
  expect((await executeWorkflow({ ...input, buildTools })).ok).toBe(false)
  expect((await executeWorkflow({ ...input, readOnly: false, automationRunId: createDenTypeId("automationRun"), buildTools })).ok).toBe(false)
})

test("live provenance overrides a snapshot source on success and preflight failure", async () => {
  const { input, receipts } = fixture()
  const receiptSource = `plugin:${input.pluginId}:${input.configObjectId}`
  for (const buildTools of [
    async () => built(() => Effect.succeed({ actor: "caller" })),
    async () => ({ tools: {}, manifest: [] }),
  ]) {
    await executeWorkflow({ ...input, receiptSource, buildTools })
    expect(receipts.at(-1)?.source).toBe(`live:${receiptSource}`)
  }
  await executeWorkflow({ ...input, readOnly: false, buildTools: async () => built(() => Effect.succeed({ actor: "caller" })) })
  expect(receipts.at(-1)?.source).toBe(receiptSource)
})

test("provider connection errors retain their actionable card", async () => {
  const { input } = fixture()
  const connectionStatus = {
    connectionId: "connection-one", connectionName: "Calendar",
    state: "needs_connection", actor: "member", message: "Connect your calendar",
    action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  }
  const result = await executeWorkflow({
    ...input,
    buildTools: async () => ({
      tools: { den: { read: Tool.make({
        description: "Read caller data",
        input: { type: "object" },
        run: () => Effect.fail(toolError(JSON.stringify({ connectionStatus }))),
      }) } },
      manifest: [{ capabilityName: "read", scriptPath: "tools.den.read", authority: "den", readOnly: true }],
    }),
  })
  expect(result).toMatchObject({
    ok: false, error: "script_failed",
    connectionStatus,
    connectionCard: { schemaVersion: "1", ...connectionStatus },
  })
})
