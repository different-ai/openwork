import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { toAnthropicBody } from "../src/auto-router/anthropic.js"
import { bedrockTranslator } from "../src/auto-router/bedrock.js"
import { isJsonObject, type JsonObject } from "../src/auto-router/chat.js"
import { googleTranslator } from "../src/auto-router/google.js"
import type { TranslateRequestInput } from "../src/auto-router/protocol.js"
import { objectToolSchema, toDraft2020 } from "../src/auto-router/tool-schema.js"

const COMBINATORS = ["anyOf", "oneOf", "allOf"]

/** What Anthropic checks at the root (found by sending each shape to the Messages API). */
function assertAnthropicRoot(schema: JsonObject) {
  assert.equal(schema.type, "object")
  for (const key of COMBINATORS) assert.equal(schema[key], undefined, `no root ${key}`)
  assert.equal(schema.$ref, undefined)
}

test("an object schema passes through unchanged", () => {
  const schema = { type: "object", properties: { path: { type: "string" }, mode: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["path"], additionalProperties: false }
  assert.deepEqual(objectToolSchema(schema), schema)
})

test("a missing, empty, scalar or array schema becomes an object without arguments", () => {
  assert.deepEqual(objectToolSchema(undefined), { type: "object", properties: {} })
  assert.deepEqual(objectToolSchema({}), { type: "object", properties: {} })
  assert.deepEqual(objectToolSchema({ properties: { a: { type: "string" } } }), { type: "object", properties: { a: { type: "string" } } })
  assert.deepEqual(objectToolSchema({ type: "string", description: "A path" }), { type: "object", properties: {}, description: "A path" })
  assert.deepEqual(objectToolSchema({ type: "array", items: { type: "string" } }), { type: "object", properties: {} })
})

test("a nullable object root becomes a plain object", () => {
  const out = objectToolSchema({ type: ["object", "null"], properties: { a: { type: "string" } } })
  assertAnthropicRoot(out)
  assert.deepEqual(out.properties, { a: { type: "string" } })
})

test("a root anyOf of required-only branches keeps the properties and names the argument sets", () => {
  // The shape MCP servers emit for "pass a or b".
  const out = objectToolSchema({
    type: "object",
    description: "Look a thing up.",
    properties: { a: { type: "string" }, b: { type: "string" } },
    anyOf: [{ required: ["a"] }, { required: ["b"] }],
  })
  assertAnthropicRoot(out)
  assert.deepEqual(out.properties, { a: { type: "string" }, b: { type: "string" } })
  assert.equal(out.required, undefined)
  assert.equal(out.description, "Look a thing up.\n\nPass exactly one of these argument sets: (1) a; (2) b.")
})

test("a root oneOf of object branches merges their properties; required only when every branch requires it", () => {
  const out = objectToolSchema({
    oneOf: [
      { type: "object", title: "By id", properties: { action: { const: "get" }, id: { type: "string" } }, required: ["action", "id"], additionalProperties: false },
      { type: "object", properties: { action: { const: "search" }, query: { type: "string" }, limit: { type: "integer" } }, required: ["action", "query"] },
      { type: "null" },
    ],
  })
  assertAnthropicRoot(out)
  assert.deepEqual(out.properties, {
    action: { anyOf: [{ const: "get" }, { const: "search" }] },
    id: { type: "string" },
    query: { type: "string" },
    limit: { type: "integer" },
  })
  assert.deepEqual(out.required, ["action"])
  // additionalProperties: false from one branch would forbid the other branch's arguments.
  assert.equal(out.additionalProperties, undefined)
  assert.equal(out.description, "Pass exactly one of these argument sets: (1) By id; (2) action=\"search\", query.")
})

test("a root allOf merges every part; a root $ref is inlined; $defs stay for nested refs", () => {
  const out = objectToolSchema({
    $defs: { Base: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, Mode: { enum: ["r", "w"] } },
    allOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } }, required: ["mode"] }],
  })
  assertAnthropicRoot(out)
  assert.deepEqual(out.properties, { path: { type: "string" }, mode: { $ref: "#/$defs/Mode" } })
  assert.deepEqual(out.required, ["path", "mode"])
  assert.ok(out.$defs)

  const referenced = objectToolSchema({ $ref: "#/definitions/Args", definitions: { Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } })
  assertAnthropicRoot(referenced)
  assert.deepEqual(referenced.properties, { q: { type: "string" } })
  assert.deepEqual(referenced.required, ["q"])
})

test("a self-referencing root ref does not loop", () => {
  const out = objectToolSchema({ $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/A" } } })
  assert.equal(out.type, "object")
})

test("draft-04/07 keywords Anthropic rejects as invalid 2020-12 are rewritten, at any depth", () => {
  assert.deepEqual(toDraft2020({
    type: "object",
    properties: {
      point: { type: "array", items: [{ type: "number" }, { type: "number" }], additionalItems: false },
      size: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
      name: { type: "string", required: true },
      note: { type: "string", required: false },
      count: { type: "int" },
      nested: { type: "object", properties: { deep: { anyOf: [{ type: "array", items: [{ type: "string" }] }] } } },
    },
    required: ["point"],
  }), {
    type: "object",
    properties: {
      point: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false },
      size: { type: "number", exclusiveMinimum: 0, maximum: 10 },
      name: { type: "string" },
      note: { type: "string" },
      count: {},
      nested: { type: "object", properties: { deep: { anyOf: [{ type: "array", prefixItems: [{ type: "string" }] }] } } },
    },
    required: ["point", "name"],
  })
})

const UNION_TOOL = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look a thing up.",
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] },
  },
}

test("Anthropic, Bedrock and Gemini requests get the object schema for a union tool", () => {
  const body = { model: "x", messages: [{ role: "user", content: "hi" }], tools: [UNION_TOOL] }

  const anthropic = toAnthropicBody(body, { model: "claude-haiku-4-5", upstreamModel: "claude-haiku-4-5", thinkingLevel: "default", maxOutputTokens: null })
  const anthropicTools = Array.isArray(anthropic.tools) ? anthropic.tools : []
  const tool = anthropicTools[0]
  assert.ok(tool && typeof tool === "object" && "input_schema" in tool)
  const inputSchema = tool.input_schema
  assert.ok(inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema))
  assertAnthropicRoot(Object.fromEntries(Object.entries(inputSchema)))

  const input: TranslateRequestInput = { body, model: "x", upstreamModel: "anthropic.claude-haiku-4-5", thinkingLevel: "default", thinkingLevels: ["default"], maxOutputTokens: null, reasoning: new Map() }
  const converse = JSON.stringify(bedrockTranslator.toUpstream(input).body)
  assert.match(converse, /"inputSchema":\{"json":\{"type":"object","properties":\{"a":\{"type":"string"\},"b":\{"type":"string"\}\}/)
  assert.doesNotMatch(converse, /anyOf/)

  const gemini = JSON.stringify(googleTranslator.toUpstream({ ...input, upstreamModel: "gemini-2.5-flash" }).body)
  // Before, Gemini got the tool without parameters at all.
  assert.match(gemini, /"parameters":\{"type":"object","description":"Pass exactly one of these argument sets: \(1\) a; \(2\) b\.","properties":\{"a":\{"type":"string"\},"b":\{"type":"string"\}\}\}/)
})

// Captured from the Codex app (ChatGPT 26.1027): two of its own MCP tools have a root oneOf.
// automation_update, a discriminated union of $refs nesting another union, was the
// "tools.18.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level" error.
const CODEX_APP_TOOLS: Record<string, JsonObject> = JSON.parse(readFileSync(new URL("./fixtures/codex-app-union-tools.json", import.meta.url), "utf8"))

test("the Codex app's union tools become one object with every argument set described", () => {
  const automation = CODEX_APP_TOOLS["mcp__codex_app__automation_update"]
  const out = objectToolSchema(automation)
  assertAnthropicRoot(out)
  assert.ok(isJsonObject(out.properties))
  assert.deepEqual(Object.keys(out.properties).sort(), [
    "destination", "executionEnvironment", "id", "kind", "localEnvironmentConfigPath", "mode", "model", "name",
    "notificationPolicy", "projectId", "prompt", "reasoningEffort", "rrule", "status", "targetThreadId",
  ])
  // Every argument set needs a mode; nothing else is required in all of them.
  assert.deepEqual(out.required, ["mode"])
  assert.equal(out.additionalProperties, undefined)
  assert.ok(isJsonObject(out.$defs) && Object.keys(out.$defs).length > 0, "nested $refs still resolve")
  assert.match(String(out.description), /^Pass exactly one of these argument sets: \(1\) mode="view", id; .*\(6\) mode="delete", id\.$/)
  assert.doesNotMatch(JSON.stringify(out.properties), /"oneOf"/)

  const js = objectToolSchema(CODEX_APP_TOOLS["mcp__cua_repl__js"])
  assertAnthropicRoot(js)
  assert.equal(js.description, "Pass exactly one of these argument sets: (1) code; (2) completion_summary.")
  assert.equal(js.additionalProperties, false)
  assert.equal(js.required, undefined)
})
