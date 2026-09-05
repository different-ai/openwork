import { expect, test } from "bun:test"
import {
  getOAuthTokenRateLimitLogFields,
  readBasicAuthClientId,
} from "../src/oauth-token-rate-limit-observability.js"

test("reads a client ID from valid Basic authentication only", () => {
  expect(readBasicAuthClientId(new Headers({ authorization: `Basic ${btoa("desktop-client:secret")}` }))).toBe("desktop-client")
  expect(readBasicAuthClientId(new Headers({ authorization: "Basic not-base64" }))).toBeNull()
  expect(readBasicAuthClientId(new Headers({ authorization: `Bearer ${btoa("desktop-client:secret")}` }))).toBeNull()
})

test("builds safe OAuth token rate-limit diagnostics from Basic auth", async () => {
  const clientId = "desktop client"
  const clientSecret = "never-log-this-secret"
  const request = new Request("https://api.example.com/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "OpenWork Desktop/1.2.3",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "never-log-this-refresh-token",
      client_id: "body-client-must-not-win",
    }),
  })
  const fields = await getOAuthTokenRateLimitLogFields(request, new Response(null, {
    status: 429,
    headers: { "retry-after": "42" },
  }))

  expect(fields).toEqual({
    grant_type: "refresh_token",
    client_id_fingerprint: "sha256:1d87be5e8568249d",
    retry_after: "42",
    user_agent_category: "openwork",
  })
  const serialized = JSON.stringify(fields)
  for (const secret of [clientId, clientSecret, "never-log-this-refresh-token", "body-client-must-not-win"]) {
    expect(serialized).not.toContain(secret)
  }
})

test("does not expose arbitrary body values and only observes token 429 responses", async () => {
  const request = new Request("https://api.example.com/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0",
    },
    body: new URLSearchParams({ grant_type: "secret-grant-value", code: "secret-code" }),
  })

  expect(await getOAuthTokenRateLimitLogFields(request, new Response(null, { status: 400 }))).toBeNull()
  const fields = await getOAuthTokenRateLimitLogFields(request, new Response(null, { status: 429 }))
  expect(fields).toEqual({
    grant_type: "other",
    client_id_fingerprint: undefined,
    retry_after: undefined,
    user_agent_category: "browser",
  })
  expect(JSON.stringify(fields)).not.toContain("secret")
})

test("categorizes MCP clients without logging raw user agents", async () => {
  const clients = [
    ["Cursor/3.17.3", "cursor"],
    ["claude-code/2.1.235", "claude_code"],
    ["codex-mcp-client/0.148.0", "codex"],
    ["opencode/1.18.18", "opencode"],
  ] as const

  for (const [userAgent, category] of clients) {
    const request = new Request("https://api.example.com/api/auth/oauth2/token", {
      method: "POST",
      headers: { "user-agent": userAgent },
    })
    const fields = await getOAuthTokenRateLimitLogFields(request, new Response(null, { status: 429 }))
    expect(fields?.user_agent_category).toBe(category)
    expect(JSON.stringify(fields)).not.toContain(userAgent)
  }
})
