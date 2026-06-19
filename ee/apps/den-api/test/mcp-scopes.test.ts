import { expect, test } from "bun:test"
import {
  DEN_MCP_DEFAULT_CLIENT_SCOPES,
  DEN_MCP_DEFAULT_TOKEN_SCOPES,
  normalizeMcpOAuthClientScope,
  resolveMcpTokenScopes,
} from "../src/mcp/scopes.js"

test("MCP OAuth client defaults are read-only", () => {
  expect(DEN_MCP_DEFAULT_CLIENT_SCOPES).toEqual(["openid", "profile", "email", "mcp:read"])
})

test("first-party MCP token mint defaults to read-only", () => {
  expect(DEN_MCP_DEFAULT_TOKEN_SCOPES).toEqual(["mcp:read"])
  expect(resolveMcpTokenScopes(undefined)).toEqual(["mcp:read"])
})

test("explicit MCP token scopes are preserved", () => {
  expect(resolveMcpTokenScopes(["mcp:write"])).toEqual(["mcp:write"])
  expect(resolveMcpTokenScopes(["mcp:read", "mcp:write"])).toEqual(["mcp:read", "mcp:write"])
})

test("OAuth client registration scope normalization does not upgrade MCP scopes", () => {
  expect(normalizeMcpOAuthClientScope("mcp:read")).toBe("mcp:read")
  expect(normalizeMcpOAuthClientScope("mcp:write")).toBe("mcp:write")
  expect(normalizeMcpOAuthClientScope(" openid   profile  mcp:read ")).toBe("openid profile mcp:read")
  expect(normalizeMcpOAuthClientScope(undefined)).toBeNull()
})
