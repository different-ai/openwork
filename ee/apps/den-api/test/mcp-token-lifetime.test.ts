import { expect, test } from "bun:test"
import {
  DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS,
  DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
} from "../src/mcp/token-lifetime.js"

test("MCP OAuth access tokens use a short lifetime", () => {
  expect(DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS).toBe(15 * 60)
})

test("rotating MCP refresh grants use a thirty-day inactivity window", () => {
  expect(DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS).toBe(30 * 24 * 60 * 60)
})

test("first-party MCP bearer tokens retain a bounded seven-day lifetime", () => {
  expect(DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
})
