import { expect, test } from "bun:test"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import { searchCapabilities } from "../src/mcp/search.js"

test("MCP catalog resolves OpenAPI parameter refs for discovery", () => {
  const document = {
    paths: {
      "/v1/synthetic/{itemId}": {
        get: {
          operationId: "getV1SyntheticItemsByItemId",
          tags: ["Capability Sources"],
          summary: "Synthetic parameter refs",
          parameters: [
            { $ref: "#/components/parameters/ComponentQuery" },
            { name: "inlineQuery", in: "query", description: "Inline query", schema: { type: "string" } },
            { $ref: "#/components/parameters/MissingQuery" },
            { $ref: "#/components/parameters/ItemId" },
          ],
        },
      },
    },
    components: {
      parameters: {
        ComponentQuery: {
          name: "componentQuery",
          in: "query",
          required: true,
          description: "Resolved query parameter",
          schema: { type: "string" },
        },
        ItemId: {
          name: "itemId",
          in: "path",
          required: true,
          description: "Resolved path parameter",
          schema: { type: "integer" },
        },
      },
    },
  }

  const catalog = buildMcpCatalog(document)
  const match = searchCapabilities(catalog, "synthetic parameter refs", 10).find((result) => result.name === "getSyntheticItems")
  if (!match) {
    throw new Error("Expected synthetic capability match")
  }
  expect(match.queryParams).toEqual(["componentQuery", "inlineQuery"])
  expect(match.pathParams).toEqual(["itemId"])

  const tool = catalog.find((operation) => operation.name === "getSyntheticItems")
  if (!tool) {
    throw new Error("Expected synthetic catalog operation")
  }
  expect(tool.inputSchema.safeParse({ path: { itemId: 42 }, query: { componentQuery: "ref", inlineQuery: "inline" } }).success).toBe(true)
})
