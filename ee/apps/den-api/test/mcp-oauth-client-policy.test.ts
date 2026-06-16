import { expect, test } from "bun:test"
import {
  getInvalidMcpOAuthRedirectUris,
  isAllowedMcpOAuthRedirectUri,
} from "../src/mcp/oauth-client-policy.js"

test("MCP OAuth redirect policy allows loopback redirects", () => {
  expect(isAllowedMcpOAuthRedirectUri("http://127.0.0.1:49321/callback")).toBe(true)
  expect(isAllowedMcpOAuthRedirectUri("http://localhost:49321/callback")).toBe(true)
  expect(isAllowedMcpOAuthRedirectUri("https://dev.localhost/callback")).toBe(true)
  expect(isAllowedMcpOAuthRedirectUri("http://[::1]:49321/callback")).toBe(true)
})

test("MCP OAuth redirect policy allows private-use custom schemes", () => {
  expect(isAllowedMcpOAuthRedirectUri("com.openwork.desktop:/oauth/callback")).toBe(true)
  expect(isAllowedMcpOAuthRedirectUri("software.openwork.app://oauth/callback")).toBe(true)
})

test("MCP OAuth redirect policy rejects public web and dangerous redirects", () => {
  expect(isAllowedMcpOAuthRedirectUri("https://example.com/oauth/callback")).toBe(false)
  expect(isAllowedMcpOAuthRedirectUri("http://example.com/oauth/callback")).toBe(false)
  expect(isAllowedMcpOAuthRedirectUri("javascript:alert(1)")).toBe(false)
  expect(isAllowedMcpOAuthRedirectUri("file:///tmp/callback")).toBe(false)
  expect(isAllowedMcpOAuthRedirectUri("openwork:/oauth/callback")).toBe(false)
})

test("MCP OAuth redirect policy lists invalid registration redirect URIs", () => {
  expect(getInvalidMcpOAuthRedirectUris([
    "http://127.0.0.1:49321/callback",
    "https://example.com/oauth/callback",
    "com.openwork.desktop:/oauth/callback",
    "data:text/plain,callback",
  ])).toEqual([
    "https://example.com/oauth/callback",
    "data:text/plain,callback",
  ])
})
