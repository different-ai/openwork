import { expect, test } from "bun:test"
import {
  getInvalidMcpOAuthRedirectUris,
  isAllowedMcpOAuthRedirectUri,
} from "../src/mcp/oauth-client-policy.js"

test("MCP OAuth redirect policy allows HTTPS, loopback HTTP, and custom schemes", () => {
  for (const uri of [
    "http://127.0.0.1:49321/callback",
    "http://localhost:49321/callback",
    "http://[::1]:49321/callback",
    "https://dev.localhost/callback",
    "com.openwork.desktop:/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "openwork:/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://example.com/oauth/callback",
  ]) {
    expect(isAllowedMcpOAuthRedirectUri(uri)).toBe(true)
  }
})

test("MCP OAuth redirect policy rejects non-loopback HTTP, blocked schemes, and non-URLs", () => {
  for (const uri of [
    "http://example.com/oauth/callback",
    "javascript:alert(1)",
    "file:///tmp/callback",
    "data:text/plain,callback",
    "vbscript:foo",
    "not a url",
  ]) {
    expect(isAllowedMcpOAuthRedirectUri(uri)).toBe(false)
  }
})

test("MCP OAuth redirect policy lists invalid registration redirect URIs", () => {
  expect(getInvalidMcpOAuthRedirectUris([
    "http://127.0.0.1:49321/callback",
    "https://example.com/oauth/callback",
    "com.openwork.desktop:/oauth/callback",
    "openwork:/oauth/callback",
    "http://example.com/oauth/callback",
    "data:text/plain,callback",
  ])).toEqual([
    "http://example.com/oauth/callback",
    "data:text/plain,callback",
  ])

  expect(getInvalidMcpOAuthRedirectUris([
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
  ])).toEqual([])
})
