import { expect, test } from "bun:test"
import { addOpenApiSocialDescriptions } from "./openapi-social-descriptions.js"

function transform(operation: Record<string, unknown>) {
  return addOpenApiSocialDescriptions({ paths: { "/example": { get: operation } } })
}

test("adds only native social metadata and preserves original values and key order", () => {
  const operation = {
    summary: "Get a SCIM group",
    tags: ["SCIM"],
    parameters: [{ name: "groupId", in: "path", required: true }],
    responses: { "200": { description: "OK" } },
  }
  const before = JSON.stringify(operation)
  const { document, counts } = transform(operation)
  const result = document.paths["/example"].get

  expect(counts).toEqual({ operationsVisited: 1, socialDescriptionsFilled: 1 })
  expect(result["x-mint"]).toEqual({
    metadata: { "og:description": "Get a SCIM group API reference in OpenWork Docs." },
  })
  expect(Object.hasOwn(result, "description")).toBe(false)
  expect(Object.keys(result)).toEqual([...Object.keys(operation), "x-mint"])
  delete result["x-mint"]
  expect(JSON.stringify(result)).toBe(before)
  expect(JSON.stringify(operation)).toBe(before)
})

test("is idempotent", () => {
  const first = transform({ summary: "Create a SCIM group" })
  const second = addOpenApiSocialDescriptions(first.document)

  expect(second.counts).toEqual({ operationsVisited: 1, socialDescriptionsFilled: 0 })
  expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document))
})

test("leaves described operations untouched", () => {
  const operation = { summary: "Get a group", description: "Existing description", tags: ["SCIM"] }
  const result = transform(operation)

  expect(result.counts.socialDescriptionsFilled).toBe(0)
  expect(JSON.stringify(result.document.paths["/example"].get)).toBe(JSON.stringify(operation))
})

test("preserves existing extension metadata without mutating the input", () => {
  const operation = {
    summary: "Replace a SCIM group",
    "x-mint": { href: "/example", metadata: { "og:title": "Custom title", robots: "index" } },
  }
  const before = JSON.stringify(operation)
  const result = transform(operation).document.paths["/example"].get

  expect(result["x-mint"]).toEqual({
    href: "/example",
    metadata: {
      "og:title": "Custom title",
      robots: "index",
      "og:description": "Replace a SCIM group API reference in OpenWork Docs.",
    },
  })
  expect(JSON.stringify(operation)).toBe(before)
})

test("never replaces an explicit OG description, including an empty value", () => {
  for (const description of ["Custom social description", "", null]) {
    const operation = {
      summary: "Delete a SCIM group",
      "x-mint": { metadata: { "og:description": description, "og:title": "Custom title" } },
    }
    const result = transform(operation)

    expect(result.counts.socialDescriptionsFilled).toBe(0)
    expect(JSON.stringify(result.document.paths["/example"].get)).toBe(JSON.stringify(operation))
  }
})

test("preserves empty ordinary descriptions while providing the social fallback", () => {
  for (const description of ["", "  "]) {
    const result = transform({ summary: "Get a group", description })

    expect(result.counts.socialDescriptionsFilled).toBe(1)
    expect(result.document.paths["/example"].get.description).toBe(description)
  }
})

test("preserves non-object extensions and ignores operations without summaries", () => {
  for (const operation of [
    { summary: "Get a group", "x-mint": null },
    { summary: "Get a group", "x-mint": { metadata: "existing" } },
    { summary: "  " },
    { responses: {} },
  ]) {
    const result = transform(operation)

    expect(result.counts.socialDescriptionsFilled).toBe(0)
    expect(JSON.stringify(result.document.paths["/example"].get)).toBe(JSON.stringify(operation))
  }
})

test("ignores path-level fields and documents without paths", () => {
  const document = { paths: { "/example": { summary: "Path summary", parameters: [], "x-custom": { summary: "Not an operation" } } } }
  const result = addOpenApiSocialDescriptions(document)

  expect(result.counts).toEqual({ operationsVisited: 0, socialDescriptionsFilled: 0 })
  expect(result.document).toEqual(document)
  expect(addOpenApiSocialDescriptions({ openapi: "3.1.0" }).counts.operationsVisited).toBe(0)
})
