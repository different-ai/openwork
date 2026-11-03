import assert from "node:assert/strict"
import { test } from "node:test"
import { publicOpenApiDocument } from "../src/openapi-public.ts"

test("public contracts filter internal operations and orphan schemas without mutating the raw cache", () => {
  const original = {
    openapi: "3.1.0",
    tags: [{ name: "Internal" }, { name: "Teams" }],
    paths: {
      "/teams": { get: { summary: "List teams", tags: ["Teams"], hide: false, responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } } } } } },
      "/internal": { post: { tags: ["Internal"], responses: { 200: { description: "Internal" } } } },
    },
    components: { schemas: { Team: { properties: { owner: { $ref: "#/components/schemas/Owner" } } }, Owner: { type: "string" }, Internal: { type: "string" } } },
  }
  const saved = structuredClone(original)
  const published = publicOpenApiDocument(original)
  assert.deepEqual(original, saved)
  const paths = published.document.paths
  assert.ok(paths && typeof paths === "object")
  assert.deepEqual(Object.keys(paths), ["/teams"])
  const components = published.document.components
  assert.ok(components && typeof components === "object" && "schemas" in components)
  const schemas = components.schemas
  assert.ok(schemas && typeof schemas === "object")
  assert.deepEqual(Object.keys(schemas), ["Team", "Owner"])
  assert.equal(published.counts.internalOperationsExcluded, 1)
  assert.equal(published.counts.orphanSchemasPruned, 1)
  assert.equal(published.counts.descriptionsFilled, 1)
  assert.equal(published.counts.socialDescriptionsFilled, 1)
  assert.deepEqual(publicOpenApiDocument(published.document).document, published.document)
})

test("an invalid OpenAPI document is rejected", () => {
  for (const input of [null, [], "invalid"]) assert.throws(() => publicOpenApiDocument(input), /not a JSON object/)
})

test("runtime-only Hono metadata is serialized just like the raw endpoint", () => {
  const hide = () => false
  const original = { paths: { "/teams": { get: { hide, summary: "List teams", responses: { 200: { description: "OK" } } } } } }
  const published = publicOpenApiDocument(original)
  assert.equal(original.paths["/teams"].get.hide, hide)
  assert.doesNotThrow(() => structuredClone(published.document))
})
