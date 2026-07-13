import { expect, test } from "bun:test"
import {
  getInvalidMcpOAuthRedirectUris,
  isAllowedMcpOAuthRedirectUri,
  MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION,
} from "../src/mcp/oauth-client-policy.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

test("MCP OAuth redirect policy allows HTTPS callbacks and HTTP loopback only", () => {
  for (const uri of [
    "http://127.0.0.1:49321/callback",
    "http://localhost:49321/callback",
    "http://[::1]:49321/callback",
    "https://dev.localhost/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://example.com/oauth/callback",
  ]) {
    expect(isAllowedMcpOAuthRedirectUri(uri)).toBe(true)
  }
})

test("MCP OAuth redirect policy rejects non-loopback HTTP, custom schemes, blocked schemes, and non-URLs", () => {
  for (const uri of [
    "http://example.com/oauth/callback",
    "com.openwork.desktop:/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "openwork:/oauth/callback",
    "javascript:alert(1)",
    "file:///tmp/callback",
    "data:text/plain,callback",
    "vbscript:foo",
    "not a url",
  ]) {
    expect(isAllowedMcpOAuthRedirectUri(uri)).toBe(false)
  }
})

test("MCP OAuth redirect policy rejects fragments", () => {
  for (const uri of [
    "https://example.com/oauth/callback#fragment",
    "https://example.com/oauth/callback#",
    "http://localhost:49321/callback#fragment",
    "http://127.0.0.1:49321/callback#fragment",
    "http://[::1]:49321/callback#fragment",
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
    "com.openwork.desktop:/oauth/callback",
    "openwork:/oauth/callback",
    "http://example.com/oauth/callback",
    "data:text/plain,callback",
  ])

  expect(getInvalidMcpOAuthRedirectUris([
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
  ])).toEqual(["cursor://anysphere.cursor-mcp/oauth/callback"])
})

test("MCP OAuth registration error copy states the MCP 2025-11-25 redirect policy", () => {
  expect(MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION).toBe("MCP OAuth redirect URIs must use HTTPS callbacks or HTTP loopback callbacks and must not include fragments.")
})

test("MCP OAuth registration rejects custom schemes with the spec redirect copy", async () => {
  seedRequiredEnv()
  const app = (await import("../src/app.js")).default
  const response = await app.fetch(new Request("http://127.0.0.1:8790/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Custom scheme test",
      redirect_uris: ["openwork:/oauth/callback"],
    }),
  }))
  expect(response.status).toBe(400)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("Registration response body was not JSON")
  expect(body.error).toBe("invalid_redirect_uri")
  expect(body.error_description).toBe(MCP_OAUTH_REDIRECT_URI_ERROR_DESCRIPTION)
})
