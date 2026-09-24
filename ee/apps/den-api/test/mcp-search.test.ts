import { describe, expect, test } from "bun:test"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import { compareCapabilityMatches, searchCapabilities } from "../src/mcp/search.js"

const catalog = buildMcpCatalog({
  paths: {
    "/v1/access": {
      post: {
        operationId: "postV1Access",
        tags: ["Plugins"],
        summary: "Create access grant",
      },
    },
    "/v1/config-objects": {
      post: {
        operationId: "postV1ConfigObjects",
        tags: ["Config Objects"],
        summary: "Create config object",
      },
    },
    "/v1/config-objects/{configObjectId}/versions": {
      post: {
        operationId: "postV1ConfigObjectsByConfigObjectIdVersions",
        tags: ["Config Objects"],
        // Overlapping words must not outrank an exact callable name.
        summary: "Post config objects versions",
      },
    },
    "/v1/plugins": {
      post: {
        operationId: "postV1Plugins",
        tags: ["Plugins"],
        summary: "Create plugin",
      },
    },
  },
})

describe("API capability search", () => {
  test.each(["postConfigObjects", " PostConfigObjects ", "POSTCONFIGOBJECTS"])(
    "an exact callable name ranks first before a one-result limit: %s",
    (query) => {
      expect(searchCapabilities(catalog, query, 1).map((match) => match.name)).toEqual(["postConfigObjects"])
    },
  )

  test("camelCase phrases have the same token matches as spaced queries", () => {
    expect(searchCapabilities(catalog, "createConfigObject"))
      .toEqual(searchCapabilities(catalog, "create config object"))
  })

  test("a longer exact name is not confused with its prefix", () => {
    expect(searchCapabilities(catalog, "postConfigObjectsVersions", 1)[0]?.name)
      .toBe("postConfigObjectsVersions")
  })

  test("exact-name priority survives the aggregate score sort", () => {
    const exact = searchCapabilities(catalog, "postConfigObjects", 1)[0]
    if (!exact) throw new Error("Expected exact capability match")
    const overlapping = {
      ...exact,
      name: "mcp:fixture:post_config_objects",
      score: 24, // Maximum ordinary score for three query tokens (5 + 2 + 1 each).
      kind: "connection_status",
    }
    expect([overlapping, exact].sort(compareCapabilityMatches)[0]?.name).toBe("postConfigObjects")
  })

  test.each(["", "   ", "???"])("empty or punctuation-only queries return no matches: %s", (query) => {
    expect(searchCapabilities(catalog, query)).toEqual([])
  })

  test("ordinary relevance and limits remain intact", () => {
    expect(searchCapabilities(catalog, "create plugin", 1)[0]?.name).toBe("postPlugins")
    expect(searchCapabilities(catalog, "config", 1)).toHaveLength(1)
    expect(searchCapabilities(catalog, "config", 20)).toHaveLength(2)
  })

  test("curated aliases are searchable without indexing request schema fields", () => {
    const catalog = buildMcpCatalog({
      paths: {
        "/v1/config-objects": {
          post: {
            operationId: "postV1ConfigObjects",
            tags: ["Config Objects"],
            summary: "Create config object",
            "x-mcp-search-aliases": ["add skill to existing plugin", null, 42],
            requestBody: {
              content: { "application/json": { schema: {
                type: "object", properties: { unsearchable: { type: "string" } },
              } } },
            },
          },
        },
      },
    })
    const match = searchCapabilities(catalog, "add skill existing plugin", 1)[0]
    expect(match?.name).toBe("postConfigObjects")
    expect(match?.score).toBe(20)
    expect(searchCapabilities(catalog, "unsearchable")).toEqual([])
    expect(searchCapabilities(catalog, "42")).toEqual([])
  })
})
