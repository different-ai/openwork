import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { McpToolOperation } from "../src/mcp/catalog.js"
import { compareCapabilityMatches, searchCapabilities, type CapabilityMatch } from "../src/mcp/search.js"

function catalogOperation(name: string, summary: string, method: string, path: string): McpToolOperation {
  return {
    name,
    method,
    path,
    operation: { summary },
    inputSchema: z.object({}),
  }
}

const catalog = [
  catalogOperation("getMarketplaces", "List marketplaces", "GET", "/v1/marketplaces"),
  catalogOperation("postMarketplaces", "Create marketplace", "POST", "/v1/marketplaces"),
  catalogOperation("getMarketplaces_rvevs7", "Get marketplace", "GET", "/v1/marketplaces/{marketplaceId}"),
  catalogOperation("deleteMarketplacesAccess", "Revoke marketplace access", "DELETE", "/v1/marketplaces/{marketplaceId}/access/{grantId}"),
  catalogOperation("deleteMarketplacesPlugins", "Remove marketplace plugin", "DELETE", "/v1/marketplaces/{marketplaceId}/plugins/{pluginId}"),
  catalogOperation("getMarketplacesAccess", "List marketplace access grants", "GET", "/v1/marketplaces/{marketplaceId}/access"),
  catalogOperation("getMarketplacesPlugins", "List marketplace plugins", "GET", "/v1/marketplaces/{marketplaceId}/plugins"),
  catalogOperation("postMarketplacesPlugins", "Add marketplace plugin", "POST", "/v1/marketplaces/{marketplaceId}/plugins"),
  catalogOperation("postPluginsArchive", "archive plugin", "POST", "/v1/plugins/{pluginId}/archive"),
  catalogOperation("postMcpConnections", "Register a new External MCP Connection for the org", "POST", "/v1/mcp-connections"),
  catalogOperation("postCapabilitiesGoogleWorkspaceCalendarEvents", "Create a Google Calendar event as the calling member", "POST", "/v1/capabilities/google-workspace/calendar/events"),
  catalogOperation("getOrganizations", "List organizations", "GET", "/v1/organizations"),
  catalogOperation("patchWorkers", "Update worker", "PATCH", "/v1/workers/{workerId}"),
]

function names(query: string, limit = 5): string[] {
  return searchCapabilities(catalog, query, limit).map((match) => match.name)
}

describe("MCP capability search ranking", () => {
  test("ranks marketplace creation first", () => {
    expect(names("create marketplace")[0]).toBe("postMarketplaces")
  })

  test("finds marketplace creation through the new synonym", () => {
    expect(names("new marketplace").slice(0, 3)).toContain("postMarketplaces")
  })

  test("ranks an exact lowercase operation name first", () => {
    expect(names("postmarketplaces")[0]).toBe("postMarketplaces")
  })

  test("ranks collection listing first", () => {
    expect(names("list marketplaces")[0]).toBe("getMarketplaces")
  })

  test("ranks POST item actions first", () => {
    expect(names("archive plugin")[0]).toBe("postPluginsArchive")
  })

  test("finds MCP connection registration through add", () => {
    expect(names("add mcp connection").slice(0, 3)).toContain("postMcpConnections")
  })

  test("returns deterministic ordering", () => {
    expect(names("create marketplace")).toEqual(names("create marketplace"))
  })

  test("prefers fewer path parameters when scores tie", () => {
    const base: CapabilityMatch = {
      name: "sameLengthA",
      method: "GET",
      path: "/v1/items",
      score: 5,
      summary: "List items",
      pathParams: [],
      queryParams: [],
      hasBody: false,
    }
    const parameterized: CapabilityMatch = {
      ...base,
      name: "sameLengthB",
      path: "/v1/items/{itemId}",
      pathParams: ["itemId"],
    }

    expect([parameterized, base].sort(compareCapabilityMatches)).toEqual([base, parameterized])
  })
})
