import { expect, test } from "bun:test"
import { buildMcpCatalog, getJsonResponseSchema } from "../src/mcp/catalog.js"
import { searchCapabilities } from "../src/mcp/search.js"

function jsonResponse(schema: unknown) {
  return { content: { "application/json": { schema } } }
}

test("discovers successful JSON output without confusing it with request or error schemas", () => {
  const schema = {
    type: "object",
    properties: { result: { type: "string" }, count: { type: "integer", minimum: 0 } },
    required: ["result"],
    additionalProperties: false,
  }
  const catalog = buildMcpCatalog({
    paths: {
      "/v1/synthetic": {
        post: {
          operationId: "postV1Synthetic",
          tags: ["Capability Sources"],
          requestBody: jsonResponse({ type: "object", properties: { input: { type: "string" } } }),
          responses: {
            201: jsonResponse(schema),
            400: jsonResponse({ type: "object", properties: { error: { type: "string" } } }),
          },
        },
      },
    },
  })
  expect(catalog[0]?.outputSchema).toEqual(schema)
  const match = searchCapabilities(catalog, "synthetic")[0]
  expect(match?.outputSchema).toEqual(schema)
  expect(match?.bodySchema).toEqual({ type: "object", properties: { input: { type: "string" } } })
})

test("combines distinct successful JSON variants deterministically and excludes non-JSON responses", () => {
  const schema = { type: "object", properties: { ok: { const: true } } }
  expect(getJsonResponseSchema({}, { responses: {
    202: { content: { "application/problem+json": { schema: { type: "string" } } } },
    200: jsonResponse(schema),
    201: jsonResponse(schema),
    204: { description: "No content" },
    206: { content: { "text/plain": { schema: { type: "string" } } } },
    "2XX": { content: { "application/json; charset=utf-8": { schema: { type: "array", items: { type: "integer" } } } } },
    500: jsonResponse({ type: "object", properties: { error: { type: "string" } } }),
    default: jsonResponse({ type: "null" }),
  } })).toEqual({ anyOf: [schema, { type: "string" }, { type: "array", items: { type: "integer" } }] })
})

test("omits output hints for absent, empty, non-JSON and error-only responses", () => {
  for (const responses of [undefined, null, {}, { 204: {} }, { 400: jsonResponse({ type: "object" }) }, {
    200: { content: { "text/event-stream": { schema: { type: "string" } } } },
  }, { 200: { content: { "application/json": {} } } }]) {
    expect(getJsonResponseSchema({}, { responses })).toBeUndefined()
  }
  const catalog = buildMcpCatalog({ paths: { "/v1/synthetic": {
    get: { operationId: "getV1Synthetic", tags: ["Capability Sources"] },
  } } })
  expect(searchCapabilities(catalog, "synthetic")[0]).not.toHaveProperty("outputSchema")
})

test("resolves response and nested schema refs including escaped JSON pointers without mutating the document", () => {
  const document = {
    components: {
      responses: { Result: { $ref: "#/components/responses/Body" }, Body: jsonResponse({ $ref: "#/components/schemas/Result" }) },
      schemas: {
        Result: {
          type: "object",
          properties: {
            events: { type: "array", items: { $ref: "#/components/schemas/Event~1time~0value" } },
            alternate: { anyOf: [{ $ref: "#/components/schemas/Text%20value" }, { type: "null" }] },
          },
          required: ["events"],
        },
        "Event/time~value": { type: "object", properties: { start: { $ref: "#/components/schemas/Text%20value" } } },
        "Text value": { type: "string" },
      },
    },
  }
  const before = JSON.stringify(document)
  const output = getJsonResponseSchema(document, { responses: { 200: { $ref: "#/components/responses/Result" } } })
  expect(output).toEqual({
    type: "object",
    properties: {
      events: { type: "array", items: { type: "object", properties: { start: { type: "string" } } } },
      alternate: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["events"],
  })
  expect(JSON.stringify(document)).toBe(before)
})

test("retains ref siblings as constraints and leaves literal ref-shaped data alone", () => {
  const document = { components: { schemas: { Text: { type: "string", minLength: 1 } } } }
  expect(getJsonResponseSchema(document, { responses: { 200: jsonResponse({
    $ref: "#/components/schemas/Text", maxLength: 10,
  }) } })).toEqual({ allOf: [{ type: "string", minLength: 1 }, { maxLength: 10 }] })
  const schema = {
    type: "object",
    properties: { $ref: { type: "string" }, constructor: { type: "boolean" } },
    examples: [{ $ref: "literal-not-a-reference" }],
  }
  expect(getJsonResponseSchema({}, { responses: { 200: jsonResponse(schema) } })).toEqual(schema)
})

test("never follows external, missing, inherited, malformed or cyclic refs", () => {
  const document = { components: { schemas: {
    Loop: { $ref: "#/components/schemas/Loop" },
    Indirect: { properties: { child: { $ref: "#/components/schemas/Indirect" } } },
  } } }
  for (const ref of [
    "https://schema.example.test/output.json", "file:///schema.json", "#/components/schemas/Missing",
    "#/components/schemas/__proto__", "#/components/schemas/constructor/prototype", "#/components/schemas/%ZZ",
    "#/components/schemas/Bad~2escape", "#/components/schemas/Loop", "#/components/schemas/Indirect",
  ]) {
    expect(getJsonResponseSchema(document, { responses: { 200: jsonResponse({ $ref: ref }) } })).toBeUndefined()
  }
  expect(getJsonResponseSchema({ components: { responses: { Loop: { $ref: "#/components/responses/Loop" } } } }, {
    responses: { 200: { $ref: "#/components/responses/Loop" } },
  })).toBeUndefined()
  expect(getJsonResponseSchema({}, { responses: { 200: { $ref: "#/components/responses/Missing" } } })).toBeUndefined()
})

test("bounds recursive depth, repeated ref expansion, width and serialized size without partial hints", () => {
  let deep: Record<string, unknown> = { type: "string" }
  for (let index = 0; index < 30; index += 1) deep = { type: "array", items: deep }
  const schemas: Record<string, unknown> = { Leaf: { type: "string" } }
  let previous = "Leaf"
  for (let index = 0; index < 15; index += 1) {
    const name = `Level${index}`
    schemas[name] = { anyOf: [{ $ref: `#/components/schemas/${previous}` }, { $ref: `#/components/schemas/${previous}` }] }
    previous = name
  }
  for (const schema of [
    deep,
    { $ref: `#/components/schemas/${previous}` },
    { type: "object", properties: Object.fromEntries(Array.from({ length: 2_100 }, (_, index) => [`field${index}`, { type: "string" }])) },
    { type: "string", description: "x".repeat(24_001) },
  ]) {
    expect(getJsonResponseSchema({ components: { schemas } }, { responses: { 200: jsonResponse(schema) } })).toBeUndefined()
  }
})

test("preserves boolean schemas and prototype-sensitive own property names safely", () => {
  expect(getJsonResponseSchema({}, { responses: { 200: jsonResponse(true) } })).toEqual({})
  expect(getJsonResponseSchema({}, { responses: { 200: jsonResponse(false) } })).toEqual({ not: {} })
  const schema = { type: "object", properties: Object.fromEntries([["__proto__", { type: "string" }]]) }
  const output = getJsonResponseSchema({}, { responses: { 200: jsonResponse(schema) } })
  expect(output).toEqual(schema)
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  expect(Object.hasOwn(Object.prototype, "type")).toBe(false)
})
