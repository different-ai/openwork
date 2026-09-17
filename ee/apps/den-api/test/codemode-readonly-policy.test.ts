import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { Tool } from "@openwork/codemode"
import { Effect } from "effect"
import type { BuiltCodemodeTools, CodemodeManifestEntry } from "../src/mcp/codemode-tools.js"
import { runCodemodeScript } from "../src/mcp/codemode-run.js"

let restrict: typeof import("../src/mcp/codemode-tools.js")["restrictReadOnlyCodemodeToolTree"]

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  restrict = (await import("../src/mcp/codemode-tools.js")).restrictReadOnlyCodemodeToolTree
})

afterAll(() => mock.restore())

function fixture() {
  const calls: string[] = []
  const manifest: CodemodeManifestEntry[] = [
    { scriptPath: "tools.den.read", capabilityName: "read", authority: "den", readOnly: true },
    { scriptPath: "tools.den.write", capabilityName: "write", authority: "den", readOnly: false },
    { scriptPath: "tools.external.hinted", capabilityName: "hinted", authority: "external", readOnly: true },
    { scriptPath: "tools.den.undeclared", capabilityName: "undeclared", authority: "den", readOnly: true },
    { scriptPath: "tools.den.legacy", capabilityName: "legacy" },
    { scriptPath: "tools.den.noAuthority", capabilityName: "noAuthority", readOnly: true },
    { scriptPath: "tools.den.noReadOnly", capabilityName: "noReadOnly", authority: "den" },
  ]
  const definition = (name: string) => Tool.make({
    description: name,
    input: { type: "object" },
    run: () => Effect.sync(() => { calls.push(name); return name }),
  })
  const built: BuiltCodemodeTools = {
    tools: {
      den: Object.fromEntries(["read", "write", "undeclared", "legacy", "noAuthority", "noReadOnly"].map((name) => [name, definition(name)])),
      external: { hinted: definition("hinted") },
    },
    manifest,
  }
  return { calls, built }
}

test("current authority and read-only metadata override forged requirements", () => {
  const { built } = fixture()
  const required = built.manifest.map((entry): CodemodeManifestEntry => ({ ...entry, authority: "den", readOnly: true }))
  const result = restrict({ built, requiredCapabilities: required })
  expect(result.missing).toEqual([])
  expect(result.unsafe.map((entry) => entry.capabilityName)).toEqual(["write", "hinted", "legacy", "noAuthority", "noReadOnly"])
  expect(Object.keys(result.tools.den ?? {})).toEqual(["read", "undeclared"])
  expect(Object.keys(result.tools)).toEqual(["den"])
  expect(Object.keys(built.tools.den ?? {})).toHaveLength(6)
})

test("requires an exact path and capability pair and an existing definition", () => {
  const { built } = fixture()
  const absent = { scriptPath: "tools.den.absent", capabilityName: "absent", authority: "den", readOnly: true } satisfies CodemodeManifestEntry
  built.manifest.push(absent)
  const required = [
    absent,
    { scriptPath: "tools.den.unknown", capabilityName: "read" },
    { scriptPath: "tools.den.read", capabilityName: "wrong" },
  ]
  expect(restrict({ built, requiredCapabilities: required })).toEqual({ tools: {}, missing: required, unsafe: [] })
})

test("empty requirements expose no tools and conflicting current metadata fails closed", () => {
  const { built } = fixture()
  expect(restrict({ built, requiredCapabilities: [] })).toEqual({ tools: {}, missing: [], unsafe: [] })
  const required = { scriptPath: "tools.den.read", capabilityName: "read" }
  built.manifest.push({ ...required, authority: "external", readOnly: true })
  expect(restrict({ built, requiredCapabilities: [required] })).toEqual({ tools: {}, missing: [], unsafe: [required] })
})

test("real runtime executes permitted tools and blocks dynamic denied or undeclared calls", async () => {
  const { built, calls } = fixture()
  const required = built.manifest.filter((entry) => entry.capabilityName !== "undeclared")
  const { tools } = restrict({ built, requiredCapabilities: required })
  const allowed = await runCodemodeScript({ code: "return await tools.den.read({})", tools, timeoutMs: 1_000 })
  expect(allowed.ok).toBe(true)
  if (allowed.ok) expect(allowed.value).toBe("read")
  for (const [namespace, name] of [["den", "write"], ["external", "hinted"], ["den", "undeclared"], ["den", "unknown"]]) {
    const result = await runCodemodeScript({
      code: "return await tools[input.namespace][input.name]({})",
      scriptInput: { namespace, name },
      tools,
      timeoutMs: 1_000,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("UnknownTool")
    expect(result.toolCalls).toEqual([])
  }
  expect(calls).toEqual(["read"])
})
