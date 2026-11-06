import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeScimUserBody, paginateScimResources, projectScimResource } from "../src/scim-protocol.js"

test("pagination preserves total, stable offsets, count zero and out-of-range pages", () => {
  const resources = [{ id: "one" }, { id: "two" }, { id: "three" }]
  for (const [query, ids, total, index] of [
    ["startIndex=1&count=1", ["one"], 3, 1],
    ["startIndex=2&count=1", ["two"], 3, 2],
    ["startIndex=3&count=10", ["three"], 3, 3],
    ["startIndex=4&count=1", [], 3, 4],
    ["count=0", [], 3, 1],
    ["startIndex=0&count=1", ["one"], 3, 1],
  ] as const) {
    const page = paginateScimResources(resources, new URL(`https://example.test/Users?${query}`))
    assert.deepEqual(page.Resources.map(resource => resource.id), ids)
    assert.equal(page.totalResults, total)
    assert.equal(page.startIndex, index)
    assert.equal(page.itemsPerPage, ids.length)
  }
})

test("attribute exclusion changes the representation, never the stored resource", () => {
  const resource = { id: "group", schemas: ["Group"], displayName: "Team", members: [{ value: "user" }] }
  assert.deepEqual(projectScimResource(resource, new URL("https://example.test/Groups?excludedAttributes=members")), { id: "group", schemas: ["Group"], displayName: "Team" })
  assert.deepEqual(projectScimResource(resource, new URL("https://example.test/Groups?attributes=displayName")), { id: "group", schemas: ["Group"], displayName: "Team" })
  assert.equal(resource.members.length, 1)
})

test("displayName normalization maps both PATCH casings and pathless attributes without changing the input", () => {
  const body = { Operations: [
    { op: "Replace", path: "displayName", value: "Mixed" },
    { op: "replace", path: "displayName", value: "Lower" },
    { op: "replace", value: { displayName: "Pathless", active: false } },
  ] }
  const normalized = normalizeScimUserBody(body)
  assert.deepEqual(normalized.Operations, [
    { op: "Replace", path: "name.formatted", value: "Mixed" },
    { op: "replace", path: "name.formatted", value: "Lower" },
    { op: "replace", value: { displayName: "Pathless", name: { formatted: "Pathless" }, active: false } },
  ])
  assert.equal(body.Operations[0]?.path, "displayName")
})
