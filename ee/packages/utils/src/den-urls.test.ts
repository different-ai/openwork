import { describe, expect, test } from "bun:test"

import { denUrls } from "./den-urls"

describe("denUrls", () => {
  test("derives nested API URLs from a bare Den base host", () => {
    expect(denUrls({ DEN_BASE_URL: "app.openworklabs.com" })).toEqual({
      base: "https://app.openworklabs.com",
      web: "https://app.openworklabs.com",
      api: "https://api.app.openworklabs.com",
      auth: "https://app.openworklabs.com/api/auth",
      inference: "https://app.openworklabs.com/dashboard/inference",
      mcp: "https://api.app.openworklabs.com/mcp",
      mcpAgent: "https://api.app.openworklabs.com/mcp/agent",
    })
  })

  test("preserves protocol and port from a full Den base origin", () => {
    expect(denUrls({ DEN_BASE_URL: "http://app.localhost:3005" })).toEqual({
      base: "http://app.localhost:3005",
      web: "http://app.localhost:3005",
      api: "http://api.app.localhost:3005",
      auth: "http://app.localhost:3005/api/auth",
      inference: "http://app.localhost:3005/dashboard/inference",
      mcp: "http://api.app.localhost:3005/mcp",
      mcpAgent: "http://api.app.localhost:3005/mcp/agent",
    })
  })

  test("rejects missing or path-like Den base values", () => {
    expect(() => denUrls({})).toThrow("DEN_BASE_URL must be configured")
    expect(() => denUrls({ DEN_BASE_URL: "https://app.openworklabs.com/api/den" })).toThrow(
      "DEN_BASE_URL must be an origin",
    )
  })
})
