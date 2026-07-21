import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

let buildMcpCatalog: typeof import("../src/mcp/catalog.js")["buildMcpCatalog"]
let searchCapabilities: typeof import("../src/mcp/search.js")["searchCapabilities"]
let catalog: ReturnType<typeof buildMcpCatalog>

beforeAll(async () => {
  buildMcpCatalog = (await import("../src/mcp/catalog.js")).buildMcpCatalog
  searchCapabilities = (await import("../src/mcp/search.js")).searchCapabilities
  catalog = buildMcpCatalog(JSON.parse(readFileSync("../../../packages/docs/openapi.json", "utf8")))
})

function names(query: string, limit = 10): string[] {
  return searchCapabilities(catalog, query, limit).map((match) => match.name)
}

describe("MCP capability catalog search", () => {
  test("pins high-value catalog relevance", () => {
    expect(names("list workers", 5)[0]).toBe("getWorkers")
    expect(names("list organization", 5)[0]).toBe("getMeOrgs")
    expect(names("invite a teammate", 5)).toContain("postInvitations")
    expect(names("store a note", 5)).toContain("postMemory")
  })

  test("preserves native request body schemas", () => {
    const match = searchCapabilities(catalog, "invite a teammate", 5)
      .find((candidate) => candidate.name === "postInvitations")
    expect(match).toEqual(expect.objectContaining({
      hasBody: true,
      bodySchema: expect.objectContaining({ type: "object" }),
    }))
  })
})
