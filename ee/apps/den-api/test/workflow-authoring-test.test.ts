import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest } from "../src/workflow-artifacts.js"
import { createWorkflowAuthoringSourceStore } from "../src/workflow-authoring-receipts.js"
import type { RecordWorkflowRunInput } from "../src/workflow-runs.js"
import type { BuiltCodemodeTools } from "../src/mcp/codemode-tools.js"

let execute: typeof import("../src/mcp/workflow-authoring-test.js")["executeWorkflowAuthoringTest"]

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  execute = (await import("../src/mcp/workflow-authoring-test.js")).executeWorkflowAuthoringTest
})

afterAll(() => mock.restore())

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object")
  return value
}

function fixture() {
  const calls: string[] = []
  const receipts: RecordWorkflowRunInput[] = []
  const store = createWorkflowAuthoringSourceStore({ redis: null })
  const identity = {
    receiptId: createDenTypeId("workflowRun"),
    organizationId: createDenTypeId("organization"),
    orgMembershipId: createDenTypeId("member"),
  }
  const definition = (name: string) => Tool.make({
    description: name,
    input: { type: "object" },
    run: () => Effect.sync(() => { calls.push(name); return { count: 2 } }),
  })
  const built: BuiltCodemodeTools = {
    tools: {
      den: { read: definition("read"), write: definition("write"), legacy: definition("legacy"), hidden: definition("hidden") },
      external: { hinted: definition("hinted") },
    },
    manifest: [
      { scriptPath: "tools.den.read", capabilityName: "read", authority: "den", readOnly: true },
      { scriptPath: "tools.den.write", capabilityName: "write", authority: "den", readOnly: false },
      { scriptPath: "tools.den.legacy", capabilityName: "legacy" },
      { scriptPath: "tools.external.hinted", capabilityName: "hinted", authority: "external", readOnly: true },
    ],
  }
  const buildTools = mock(async () => built)
  const retainSource = mock(store.retain)
  const context = {
    ...identity,
    buildTools,
    recordRun: async (receipt: RecordWorkflowRunInput) => { receipts.push(receipt); return identity.receiptId },
    retainSource,
    retentionMetadata: async () => store.metadata(),
  }
  return { calls, receipts, store, identity, built, context, buildTools, retainSource }
}

test("live interpreter receives exactly the server runtime and retains its matching digest", async () => {
  for (const timeZone of [undefined, "America/Los_Angeles", "Asia/Kolkata"]) {
    const f = fixture()
    const before = Date.now()
    const result = await execute({ mode: "live", code: "return input", ...(timeZone ? { timeZone } : {}) }, f.context)
    const after = Date.now()
    expect(result.isError).not.toBe(true)
    const structured = record(result.structuredContent)
    const value = record(structured.value)
    expect(Object.keys(value)).toEqual(["runtime"])
    const runtime = record(value.runtime)
    expect(typeof runtime.now).toBe("string")
    if (typeof runtime.now !== "string") throw new Error("Missing runtime now")
    expect(Date.parse(runtime.now)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(runtime.now)).toBeLessThanOrEqual(after)
    expect(value).toEqual({ runtime: artifactRuntime(timeZone, new Date(runtime.now)) })
    expect(record(structured.metadata)).toMatchObject({ mode: "live", executionType: "authoring-test",
      timeZone: timeZone ?? "UTC", verification: "not-requested", receiptId: f.identity.receiptId })
    const retained = await f.store.get(f.identity)
    expect(retained).toMatchObject({ mode: "live", source: "authoring:live", runtime, inputDigest: artifactDigest(value) })
    expect(f.receipts[0]).toMatchObject({ source: "authoring:live", status: "succeeded", scriptInputDigest: artifactDigest(value) })
    expect(f.receipts[0]).not.toHaveProperty("validatedResult")
    expect(f.receipts[0]).not.toHaveProperty("resultMarkdown")
    expect(f.receipts[0]).not.toHaveProperty("scriptInput")
    const metadata = record(structured.metadata)
    expect(metadata.executedAt).toBe(f.receipts[0]?.startedAt.toISOString())
    expect(metadata.fetchedAt).toBe(f.receipts[0]?.finishedAt.toISOString())
  }
})

test("live rejects every caller input including null, undefined and forged runtime before building tools", async () => {
  for (const input of [null, undefined, {}, "{}", "", 0, false, [], { runtime: { now: "forged", timeZone: "UTC" } }]) {
    const f = fixture()
    const result = await execute({ code: "return input", mode: "live", input }, f.context)
    expect(result.isError).toBe(true)
    expect(f.buildTools).not.toHaveBeenCalled()
    expect(f.retainSource).not.toHaveBeenCalled()
    expect(f.receipts).toEqual([])
  }
})

test("rejects invalid time zones, adhoc time zones and top-level forged runtime", async () => {
  for (const args of [
    { mode: "live", timeZone: "Not/A_Zone" }, { mode: "live", timeZone: "" },
    { timeZone: "UTC" }, { mode: "adhoc", timeZone: "UTC" },
    { mode: "live", runtime: { now: "forged" } }, { mode: "unknown" },
  ]) {
    const f = fixture()
    expect((await execute({ code: "return 2", ...args }, f.context)).isError).toBe(true)
    expect(f.buildTools).not.toHaveBeenCalled()
  }
})

test("live strips mutation, external hinted and undeclared paths even inside try/catch", async () => {
  for (const path of ["tools.den.write", "tools.external.hinted", "tools.den.legacy", "tools.den.hidden", "tools.den['write']"]) {
    const direct = fixture()
    const denied = await execute({ mode: "live", code: `return await ${path}({})` }, direct.context)
    expect(denied.isError).toBe(true)
    expect(direct.calls).toEqual([])
    expect(direct.retainSource).not.toHaveBeenCalled()
    expect(direct.receipts[0]?.status).toBe("failed")
    const caught = fixture()
    const result = await execute({ mode: "live", code: `try { await ${path}({}) } catch (error) { return 2 } return 3` }, caught.context)
    expect(result.isError).not.toBe(true)
    expect(record(result.structuredContent).value).toBe(2)
    expect(caught.calls).toEqual([])
    expect(caught.receipts[0]?.toolCalls).toEqual([])
  }
})

test("live interpreter discovery sees only the restricted read-only catalog", async () => {
  const f = fixture()
  const result = await execute({ mode: "live", code: 'return await tools.$codemode.search({query:"read write hinted hidden"})' }, f.context)
  expect(result.isError).not.toBe(true)
  const value = JSON.stringify(record(result.structuredContent).value)
  expect(value).not.toContain("den.write")
  expect(value).not.toContain("external.hinted")
  expect(value).not.toContain("den.hidden")
  expect(f.calls).toEqual([])
})

test("live executes read tools and adhoc preserves write access", async () => {
  for (const mode of ["live", "adhoc"]) {
    const f = fixture()
    const name = mode === "live" ? "read" : "write"
    const result = await execute({ mode, code: `return await tools.den.${name}({})` }, f.context)
    expect(result.isError).not.toBe(true)
    expect(record(result.structuredContent).value).toEqual({ count: 2 })
    expect(f.calls).toEqual([name])
  }
})

test("live supports the same confined date operations as saved runs", async () => {
  const f = fixture()
  const result = await execute({ mode: "live", code: "return new Date(input.runtime.dayStart).toISOString()" }, f.context)
  expect(result.isError).not.toBe(true)
  expect(record(result.structuredContent).value).toBe((await f.store.get(f.identity))?.runtime?.dayStart)
})

test("live runtime is immutable in the interpreter", async () => {
  for (const code of ['input.runtime.today = "forged"; return input', 'input.runtime = {}; return input', 'input = {}; return input']) {
    const f = fixture()
    expect((await execute({ mode: "live", code }, f.context)).isError).toBe(true)
    expect(f.calls).toEqual([])
    expect(f.retainSource).not.toHaveBeenCalled()
  }
})

test("async contracts fail before any dispatch", async () => {
  for (const field of ["inputSchema", "outputSchema"]) {
    const f = fixture()
    const result = await execute({ code: "return await tools.den.write({})", [field]: { $async: true, type: "number" } }, f.context)
    expect(result.isError).toBe(true)
    expect(f.calls).toEqual([])
    expect(f.buildTools).not.toHaveBeenCalled()
  }
})

test("adhoc normalizes input, hashes null when absent, and preserves first text compatibility", async () => {
  for (const input of [undefined, null, { count: 2 }, '{"count":2}']) {
    const f = fixture()
    const result = await execute({ code: "return 1 + 1", ...(input === undefined ? {} : { input }) }, f.context)
    expect(result.content[0]).toEqual({ type: "text", text: "2" })
    expect(result.content).toHaveLength(2)
    expect(f.receipts[0]).toMatchObject({ source: "adhoc", scriptInputDigest: artifactDigest(input == null ? null : { count: 2 }), inputSchemaDigest: null, outputSchemaDigest: null })
    const retained = await f.store.get(f.identity)
    expect(retained?.inputDigest).toBe(f.receipts[0]?.scriptInputDigest)
    expect(retained).not.toHaveProperty("runtime")
    expect(record(record(result.structuredContent).metadata)).toMatchObject({ mode: "adhoc", verification: "not-requested",
      retention: { scope: "process", ttlMs: 900_000, available: true, canSaveByReceipt: true } })
  }
  const f = fixture()
  const result = await execute({ code: "return input.count", input: '{"count":2}' }, f.context)
  expect(record(result.structuredContent).value).toBe(2)
})

test("input contract fails before dispatch and malformed schemas fail before dispatch", async () => {
  for (const contract of [
    { input: { count: "wrong" }, inputSchema: { type: "object", properties: { count: { type: "number" } } } },
    { inputSchema: { type: "not-a-type" } }, { outputSchema: { type: "not-a-type" } },
    { inputSchema: [] }, { outputSchema: true },
  ]) {
    const f = fixture()
    const result = await execute({ code: "return await tools.den.write({})", ...contract }, f.context)
    expect(result.isError).toBe(true)
    expect(f.buildTools).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
    expect(f.retainSource).not.toHaveBeenCalled()
  }
})

test("output contract fails after real execution without retaining source or durable result", async () => {
  const f = fixture()
  const result = await execute({ code: "return await tools.den.read({})", outputSchema: { type: "string" } }, f.context)
  expect(result.isError).toBe(true)
  expect(f.calls).toEqual(["read"])
  expect(f.receipts[0]).toMatchObject({ status: "failed", errorKind: "InvalidResult", resultDigest: artifactDigest({ count: 2 }) })
  expect(f.receipts[0]).not.toHaveProperty("validatedResult")
  expect(f.receipts[0]).not.toHaveProperty("resultMarkdown")
  expect(f.retainSource).not.toHaveBeenCalled()
})

test("successful contracts return schema verification and retain only source plus contract hashes", async () => {
  const f = fixture()
  const schema = { type: "object", required: ["count"], additionalProperties: false, properties: { count: { type: "number" } } }
  const result = await execute({ code: "return input", input: '{"count":2}', inputSchema: schema, outputSchema: schema }, f.context)
  expect(record(record(result.structuredContent).metadata).verification).toBe("schema")
  expect(f.receipts[0]).toMatchObject({ inputSchemaDigest: artifactDigest(schema), outputSchemaDigest: artifactDigest(schema), resultDigest: artifactDigest({ count: 2 }) })
  const retained = await f.store.get(f.identity)
  expect(retained).toMatchObject({ inputSchemaDigest: artifactDigest(schema), outputSchemaDigest: artifactDigest(schema) })
  expect(retained).not.toHaveProperty("input")
  expect(retained).not.toHaveProperty("result")
})

test("secret-looking source executes but cannot be saved by receipt", async () => {
  const f = fixture()
  const result = await execute({ code: 'const token = "not-a-real-secret"; return 2' }, f.context)
  expect(result.isError).not.toBe(true)
  expect(result.content[0]).toEqual({ type: "text", text: "2" })
  expect(record(record(result.structuredContent).metadata)).toMatchObject({ receiptId: f.identity.receiptId,
    retention: { available: false, canSaveByReceipt: false, error: "workflow_source_contains_secret", message: expect.stringContaining("not available") } })
  expect(f.retainSource).not.toHaveBeenCalled()
  expect(await f.store.get(f.identity)).toBeNull()
})

test("source errors, missing members and failed receipt persistence never fail successful execution", async () => {
  for (const kind of ["source-error", "source-declined", "missing-member", "receipt-null", "receipt-error", "metadata-error", "shared", "unavailable"]) {
    const f = fixture()
    if (kind === "source-error") f.context.retainSource.mockImplementation(async () => { throw new Error("unavailable") })
    if (kind === "source-declined") f.context.retainSource.mockImplementation(async () => false)
    const result = await execute({ code: "return 2" }, {
      ...f.context,
      ...(kind === "missing-member" ? { orgMembershipId: undefined } : {}),
      ...(kind === "receipt-null" ? { recordRun: async () => null } : {}),
      ...(kind === "receipt-error" ? { recordRun: async () => { throw new Error("unavailable") } } : {}),
      ...(kind === "metadata-error" ? { retentionMetadata: async () => { throw new Error("unavailable") } } : {}),
      ...(kind === "shared" || kind === "unavailable" ? { retentionMetadata: async () => ({ scope: kind, ttlMs: 900_000 }) } : {}),
    })
    expect(result.isError).not.toBe(true)
    expect(record(record(record(result.structuredContent).metadata).retention).canSaveByReceipt).toBe(kind === "shared")
    if (["missing-member", "receipt-null", "receipt-error"].includes(kind)) expect(f.retainSource).not.toHaveBeenCalled()
  }
})
