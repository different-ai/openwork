import { expect, test } from "bun:test"
import {
  DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS,
  DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS,
} from "../src/mcp/token-lifetime.js"

test("MCP OAuth access tokens use a short lifetime", () => {
  expect(DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS).toBe(15 * 60)
})

test("MCP refresh and first-party opaque tokens expire after seven days", () => {
  expect(DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS).toBe(7 * 24 * 60 * 60)
  expect(DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS).toBe(DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS * 1000)
})
