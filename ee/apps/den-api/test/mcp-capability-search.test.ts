import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

let buildMcpCatalog: typeof import("../src/mcp/catalog.js")["buildMcpCatalog"]
let searchCapabilities: typeof import("../src/mcp/search.js")["searchCapabilities"]
let catalog: ReturnType<typeof buildMcpCatalog>

beforeAll(async () => {
  buildMcpCatalog = (await import("../src/mcp/catalog.js")).buildMcpCatalog
  searchCapabilities = (await import("../src/mcp/search.js")).searchCapabilities
  const openApiJson = readFileSync("../../../packages/docs/openapi.json", "utf8")
  catalog = buildMcpCatalog(JSON.parse(openApiJson))
})

function search(query: string, limit = 10) {
  return searchCapabilities(catalog, query, limit)
}

function names(query: string, limit = 10): string[] {
  return search(query, limit).map((match) => match.name)
}

describe("MCP capability catalog search", () => {
  test("pins high-value catalog ordering", () => {
    expect(names("list workers", 5)[0]).toBe("getWorkers")
    expect(names("list organization", 5)[0]).toBe("getOrg")
    expect(names("invite a teammate", 5)).toContain("postInvitations")
  })

  test("returns rest source and normalized score scale", () => {
    const matches = search("list organization", 5)
    expect(matches.length).toBeGreaterThan(0)
    for (const match of matches) {
      expect(match.source).toBe("rest")
      expect(Number.isInteger(match.score)).toBe(true)
      expect(match.score).toBeGreaterThan(0)
      expect(match.score).toBeLessThanOrEqual(100)
    }
  })
})
