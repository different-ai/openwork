import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { Tool } from "@openwork/codemode"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Effect } from "effect"
import {
  parseCodemodeScriptPayload,
  validateCodemodeScriptInput,
  validateCodemodeScriptOutput,
} from "../src/mcp/codemode-script-object.js"

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

test("input and output validators isolate different contracts sharing the same caller id", () => {
  const stringSchema = { $id: "urn:synthetic:shared-contract", type: "string" }
  const numberSchema = { $id: stringSchema.$id, type: "number" }
  expect(validateCodemodeScriptInput(stringSchema, "value")).toEqual({ ok: true })
  expect(validateCodemodeScriptInput(numberSchema, 3)).toEqual({ ok: true })
  expect(validateCodemodeScriptOutput(numberSchema, "value")).toMatchObject({ ok: false, error: "invalid_arguments" })
  expect(validateCodemodeScriptOutput(stringSchema, 3)).toMatchObject({ ok: false, error: "invalid_arguments" })
  expect(validateCodemodeScriptOutput(stringSchema, "value")).toEqual({ ok: true })
})

test("revalidating a mutated schema uses its actual current contract", () => {
  const schema = { $id: "urn:synthetic:mutable-contract", type: "string" }
  expect(validateCodemodeScriptInput(schema, "value")).toEqual({ ok: true })
  schema.type = "number"
  expect(validateCodemodeScriptInput(schema, "value")).toMatchObject({ ok: false, error: "invalid_arguments" })
  expect(validateCodemodeScriptOutput(schema, 3)).toEqual({ ok: true })
})

const asyncSchemas: Record<string, unknown>[] = [
  { $async: true, type: "object", required: ["missing"] },
  { type: "object", properties: { child: { $async: true, type: "string" } } },
  { type: "object", $defs: { child: { $async: true, type: "string" } } },
  { type: "object", definitions: { child: { $async: true, type: "string" } } },
  { type: "object", allOf: [{ $async: true, type: "object" }] },
  { type: "object", additionalProperties: { $async: true, type: "string" } },
  { type: "array", items: { $async: true, type: "string" } },
  { type: "array", items: [{ $async: true, type: "string" }] },
  { type: "object", dependencies: { child: { $async: true, type: "object" } } },
  { type: "object", if: { $async: true, type: "object" }, then: { type: "object" } },
]

for (const [index, schema] of asyncSchemas.entries()) {
  test(`rejects async schemas before compiling or invoking a validator (${index})`, () => {
    const compile = spyOn(AjvJsonSchemaValidator.prototype, "getValidator")
    try {
      expect(validateCodemodeScriptInput(schema, {})).toMatchObject({ ok: false, error: "invalid_schema" })
      expect(validateCodemodeScriptOutput(schema, {})).toMatchObject({ ok: false, error: "invalid_schema" })
      for (const key of ["inputSchema", "outputSchema"]) {
        expect(parseCodemodeScriptPayload({ language: "codemode-js", requiredCapabilities: [], [key]: schema }))
          .toMatchObject({ ok: false })
      }
      expect(compile).not.toHaveBeenCalled()
    } finally {
      compile.mockRestore()
    }
  })
}

test("async-looking application data is not interpreted as an async schema", () => {
  const schema = {
    type: "object", properties: { $async: { type: "boolean" } },
    const: { $async: true }, default: { $async: true }, examples: [{ $async: true }],
  }
  expect(validateCodemodeScriptInput(schema, { $async: true })).toEqual({ ok: true })
  expect(parseCodemodeScriptPayload({ language: "codemode-js", requiredCapabilities: [], inputSchema: schema })).toMatchObject({ ok: true })
})

test("async input and output contracts reject authoring before side effects or unhandled rejections", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", onUnhandled)
  try {
    for (const schema of asyncSchemas) {
      for (const key of ["inputSchema", "outputSchema"]) {
        const dispatch = mock(() => ({}))
        const buildTools = mock(async () => ({
          tools: { den: { write: Tool.make({ description: "Synthetic write", input: { type: "object" }, run: () => Effect.sync(dispatch) }) } },
          manifest: [],
        }))
        const recordRun = mock(async () => createDenTypeId("workflowRun"))
        const retainSource = mock(async () => true)
        const result = await execute({ code: "return await tools.den.write({})", [key]: schema }, {
          organizationId: createDenTypeId("organization"), orgMembershipId: createDenTypeId("member"),
          buildTools, recordRun, retainSource,
        })
        expect(result.isError).toBe(true)
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"error":"invalid_schema"') })
        expect(buildTools).not.toHaveBeenCalled()
        expect(dispatch).not.toHaveBeenCalled()
        expect(recordRun).not.toHaveBeenCalled()
        expect(retainSource).not.toHaveBeenCalled()
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("separate authoring callers cannot poison input or output validation through schema ids", async () => {
  for (const key of ["inputSchema", "outputSchema"]) {
    const context = () => ({
      organizationId: createDenTypeId("organization"), orgMembershipId: createDenTypeId("member"),
      buildTools: mock(async () => ({ tools: {}, manifest: [] })),
      recordRun: mock(async () => createDenTypeId("workflowRun")),
      retainSource: mock(async () => true),
      retentionMetadata: async () => ({ scope: "process", ttlMs: 900_000 } satisfies { scope: "process"; ttlMs: number }),
    })
    const first = context()
    const second = context()
    const id = `urn:synthetic:cross-caller:${key}`
    expect((await execute({ code: "return input", input: "value", [key]: { $id: id, type: "string" } }, first)).isError).not.toBe(true)
    expect((await execute({ code: "return input", input: "value", [key]: { $id: id, type: "number" } }, second)).isError).toBe(true)
    expect(second.retainSource).not.toHaveBeenCalled()
    if (key === "inputSchema") expect(second.buildTools).not.toHaveBeenCalled()
  }
})
