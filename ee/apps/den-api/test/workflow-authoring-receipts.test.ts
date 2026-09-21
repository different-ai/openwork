import { expect, spyOn, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest } from "../src/workflow-artifacts.js"
import { codemodeCodeDigest } from "../src/workflow-runs.js"
import {
  assertWorkflowSourceSafe,
  createWorkflowAuthoringSourceStore,
  type WorkflowAuthoringSourceInput,
} from "../src/workflow-authoring-receipts.js"

const store = createWorkflowAuthoringSourceStore({ redis: null })
const retainWorkflowAuthoringSource = store.retain
const getWorkflowAuthoringSource = store.get

function source(overrides: Partial<WorkflowAuthoringSourceInput> = {}): WorkflowAuthoringSourceInput {
  return {
    receiptId: createDenTypeId("workflowRun"),
    organizationId: createDenTypeId("organization"),
    orgMembershipId: createDenTypeId("member"),
    code: "return input",
    mode: "adhoc",
    inputDigest: artifactDigest(null),
    inputSchemaDigest: null,
    outputSchemaDigest: null,
    ...overrides,
  }
}

test("retains exact source and digests, not extra caller inputs or results", async () => {
  const original = source({ code: "  return input;\n" })
  const candidate = { ...original, input: { secret: "caller-value" }, result: "private-result" }
  expect(await retainWorkflowAuthoringSource(candidate)).toBe(true)
  expect((await getWorkflowAuthoringSource(original))).toEqual({ ...original, codeDigest: codemodeCodeDigest(original.code), source: "adhoc" })
  expect(JSON.stringify((await getWorkflowAuthoringSource(original)))).not.toContain("caller-value")
  expect(JSON.stringify((await getWorkflowAuthoringSource(original)))).not.toContain("private-result")
  original.code = "return 'changed'"
  expect((await getWorkflowAuthoringSource(original))?.code).toBe("  return input;\n")
  expect(Object.isFrozen((await getWorkflowAuthoringSource(original)))).toBe(true)
})

test("foreign organizations and members cannot read or overwrite retained source", async () => {
  const original = source()
  expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  for (const foreign of [
    { ...original, organizationId: createDenTypeId("organization") },
    { ...original, orgMembershipId: createDenTypeId("member") },
  ]) {
    expect(await getWorkflowAuthoringSource(foreign)).toBeNull()
    expect(await retainWorkflowAuthoringSource({ ...foreign, code: "return 'foreign source'" })).toBe(true)
    expect((await getWorkflowAuthoringSource(original))?.code).toBe(original.code)
  }
})

test("retained contracts are exact, digest-bound and immune to caller or reader mutation", async () => {
  const schema = { type: "object", properties: { count: { type: "number" } } }
  const contract = { input: { count: 2 }, inputSchema: schema, outputSchema: schema }
  const original = source({ contract, inputDigest: artifactDigest(contract.input),
    inputSchemaDigest: artifactDigest(schema), outputSchemaDigest: artifactDigest(schema) })
  expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  const expected = structuredClone(contract)
  contract.input.count = 99
  schema.properties.count.type = "string"
  const retained = await getWorkflowAuthoringSource(original)
  expect(retained?.contract).toEqual(expected)
  if (!retained?.contract) throw new Error("Missing contract")
  retained.contract.input = { count: -1 }
  expect((await getWorkflowAuthoringSource(original))?.contract).toEqual(expected)
  expect(await retainWorkflowAuthoringSource({ ...original, receiptId: createDenTypeId("workflowRun") })).toBe(false)
})

test("receipt retention is immutable and accepts digests rather than raw input metadata", async () => {
  const original = source()
  expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  expect(await retainWorkflowAuthoringSource({ ...original, code: "return 'changed'" })).toBe(false)
  expect((await getWorkflowAuthoringSource(original))?.code).toBe(original.code)
  for (const change of [
    { inputDigest: "raw-caller-input" },
    { inputSchemaDigest: "raw-schema" },
    { outputSchemaDigest: "raw-schema" },
  ]) expect(await retainWorkflowAuthoringSource(source(change))).toBe(false)
})

test("entry expires at fifteen minutes without sliding expiration", async () => {
  const now = Date.now()
  const timer = spyOn(Date, "now").mockReturnValue(now)
  try {
    const original = source()
    expect(await retainWorkflowAuthoringSource(original)).toBe(true)
    timer.mockReturnValue(now + 15 * 60_000 - 1)
    expect((await getWorkflowAuthoringSource(original))).not.toBeNull()
    timer.mockReturnValue(now + 15 * 60_000)
    expect((await getWorkflowAuthoringSource(original))).toBeNull()
  } finally {
    timer.mockRestore()
  }
})

test("evicts oldest sources above two hundred entries", async () => {
  const originals = Array.from({ length: 201 }, () => source())
  for (const original of originals) expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  const first = originals[0]
  const last = originals.at(-1)
  if (!first || !last) throw new Error("missing fixture")
  expect(await getWorkflowAuthoringSource(first)).toBeNull()
  expect(await getWorkflowAuthoringSource(last)).not.toBeNull()
})

test("evicts at the memory bound and denies oversized sources", async () => {
  const originals = Array.from({ length: 50 }, () => source({ code: "return null;" + " ".repeat(199_980) }))
  for (const original of originals) expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  const retained = (await Promise.all(originals.map(getWorkflowAuthoringSource))).filter(Boolean)
  expect(retained.length).toBeGreaterThan(0)
  expect(retained.length).toBeLessThanOrEqual(41)
  expect(await retainWorkflowAuthoringSource(source({ code: " ".repeat(200_001) }))).toBe(false)
})

test("live provenance retains only an immutable generated runtime and verifies its digest", async () => {
  const runtime = artifactRuntime("America/Los_Angeles")
  const original = source({ mode: "live", runtime, inputDigest: artifactDigest({ runtime }) })
  expect(await retainWorkflowAuthoringSource(original)).toBe(true)
  const retained = (await getWorkflowAuthoringSource(original))
  expect(retained?.source).toBe("authoring:live")
  expect(retained?.runtime).toEqual(runtime)
  expect(Object.isFrozen(retained?.runtime)).toBe(true)
  runtime.today = "1900-01-01"
  expect(retained?.runtime?.today).not.toBe(runtime.today)
  expect(await retainWorkflowAuthoringSource(source({ mode: "live" }))).toBe(false)
  expect(await retainWorkflowAuthoringSource(source({ runtime }))).toBe(false)
  expect(await retainWorkflowAuthoringSource(source({ mode: "live", runtime }))).toBe(false)
})

for (const code of [
  'return "sk-"',
  "return input.apiKey",
  'const apiKey = ("" + ""); return null',
  "const token = input.token; return await tools.den.read({ token })",
  "return { token: input.token, password: input.password }",
  "const apiKey = (input.apiKey); return { apiKey }",
  "const apiKey = /* parameter */ (input.apiKey); return apiKey",
  "const apiKey = input.apiKey; const headers = {}; headers.authorization = (apiKey); return headers",
  "return { apiKey: /* parameter */ (input.apiKey) }",
]) {
  test(`allows parameterized source: ${code}`, async () => {
    expect(() => assertWorkflowSourceSafe(code)).not.toThrow()
    const original = source({ code })
    expect(await retainWorkflowAuthoringSource(original)).toBe(true)
    expect((await getWorkflowAuthoringSource(original))?.code).toBe(code)
  })
}

const secretSources = [
  'const apiKey = "synthetic-credential"; return null',
  'const apiKey = ("synthetic-literal-credential"); return null',
  'const apiKey /* name */ = /* value */ ("synthetic-literal-credential"); return null',
  'const apiKey =\n/* value */ ((`synthetic-literal-credential`)); return null',
  'return { apiKey: /* value */ ("synthetic-literal-credential") }',
  'const headers = {}; headers.authorization /* name */ = ("synthetic-literal-credential"); return headers',
  'const headers = {}; headers["apiKey"] = /* value */ ("synthetic-literal-credential"); return headers',
  'return { ["apiKey"]: ("synthetic-literal-credential") }',
  'const { apiKey = ("synthetic-literal-credential") } = input; return apiKey',
  'const apiKey = ("synthetic-literal-" + "credential"); return apiKey',
  'const apiKey = ("synthetic-literal-credential" + ""); return null',
  'const apiKey = ("" + "synthetic-literal-credential"); return null',
  'const apiKey = (("" + "synthetic-literal-credential") + ""); return null',
  'return { "access_token": "synthetic-credential" }',
  'const clientSecret = `synthetic-credential`; return null',
  'const sessionToken = "synthetic-credential"; return null',
  'return { passphrase: "synthetic-credential" }',
  'headers["Authorization"] = "Bearer synthetic-credential"; return null',
  'return "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"',
  'return "xoxb-synthetic-credential"',
  'return "sk-synthetic-credential"',
  'return "-----BEGIN PRIVATE KEY-----"',
  'return "https://user:synthetic-password@example.invalid"',
  'return "https://example.invalid?api_key=synthetic-credential"',
  'return "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj"',
  'return "\\x73\\x6b-synthetic-credential"',
  'const api\\u004bey = "synthetic-credential"; return null',
]

for (const [index, code] of secretSources.entries()) {
  test(`rejects literal credentials without sanitizing or echoing source (${index})`, async () => {
    const original = source({ code })
    expect(await retainWorkflowAuthoringSource(original)).toBe(false)
    expect((await getWorkflowAuthoringSource(original))).toBeNull()
    try {
      assertWorkflowSourceSafe(code)
      throw new Error("expected secret rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : "").toBe("workflow_source_contains_secret")
    }
  })
}
