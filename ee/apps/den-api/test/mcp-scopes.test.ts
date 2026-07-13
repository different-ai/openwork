import { expect, test } from "bun:test"
import {
  addRequestedMcpClientScopes,
  DEN_MCP_DEFAULT_CLIENT_SCOPES,
  DEN_MCP_DEFAULT_TOKEN_SCOPES,
  DEN_MCP_REQUESTED_SCOPE,
  DEN_MCP_REQUESTED_SCOPES,
  normalizeMcpOAuthClientScope,
  resolveMcpTokenScopes,
} from "../src/mcp/scopes.js"

test("MCP OAuth requested scopes include read, write, and offline refresh access", () => {
  expect(DEN_MCP_REQUESTED_SCOPES).toEqual(["mcp:read", "mcp:write", "offline_access"])
  expect(DEN_MCP_REQUESTED_SCOPE).toBe("mcp:read mcp:write offline_access")
  expect(DEN_MCP_DEFAULT_CLIENT_SCOPES).toEqual(DEN_MCP_REQUESTED_SCOPES)
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

test("a legacy MCP client can opt in to requested write access", () => {
  expect(addRequestedMcpClientScopes(
    ["openid", "mcp:read"],
    ["openid", "mcp:read", "mcp:write"],
  )).toEqual(["openid", "mcp:read", "mcp:write"])
})

test("a legacy MCP client is not implicitly upgraded to write access", () => {
  expect(addRequestedMcpClientScopes(
    ["openid", "mcp:read"],
    ["openid", "mcp:read", "offline_access"],
  )).toEqual(["openid", "mcp:read", "offline_access"])
})

test("non-MCP OAuth clients cannot gain MCP scopes through authorization", () => {
  expect(addRequestedMcpClientScopes(
    ["openid", "profile"],
    ["openid", "profile", "mcp:write", "offline_access"],
  )).toEqual(["openid", "profile"])
})
