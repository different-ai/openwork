import assert from "node:assert/strict"
import { test } from "node:test"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/unused"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-mcp-domain-test-encryption-key"
process.env.BETTER_AUTH_URL ??= "https://web.example.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-mcp-domain-test-authentication-secret"
const { env } = await import("../src/env.js")
const { externalMcpCallbackOriginChanged, externalMcpCompatibleCallbackUrl } = await import("../src/capability-sources/external-mcp-oauth-contract.js")

const connection = { connectionId: "connection-example", createdAt: new Date("2026-10-01") }

test("domain recovery is opt-in and preserves the stored shared or legacy callback on the same origin", () => {
  env.apiPublicUrl = "https://new.example.test/base"
  env.betterAuthUrl = "https://web.example.test"
  for (const callbackMode of ["shared-v1", "legacy-v1"] as const) {
    const path = callbackMode === "shared-v1" ? "/v1/mcp-connections/oauth/callback" : "/v1/mcp-connections/connection-example/connect/callback"
    const input = { ...connection, callbackMode, registeredRedirectUri: `https://old.example.test${path}` }
    assert.equal(externalMcpCallbackOriginChanged(input), true)
    assert.equal(externalMcpCompatibleCallbackUrl(input), input.registeredRedirectUri)
    assert.equal(externalMcpCompatibleCallbackUrl({ ...input, recoverPublicOrigin: true }), `https://new.example.test/base${path}`)
    const sameOrigin = { ...input, registeredRedirectUri: `https://new.example.test${path}` }
    assert.equal(externalMcpCompatibleCallbackUrl({ ...sameOrigin, recoverPublicOrigin: true }), sameOrigin.registeredRedirectUri)
  }
})

test("missing and invalid stored callbacks are not evidence of origin drift", () => {
  env.apiPublicUrl = "https://new.example.test"
  for (const registeredRedirectUri of [null, undefined, "invalid", "javascript:alert(1)"]) {
    assert.equal(externalMcpCallbackOriginChanged({ ...connection, callbackMode: "shared-v1", registeredRedirectUri }), false)
  }
})

test("the intentional hosted web proxy callback remains compatible, but arbitrary old hosts do not", () => {
  env.apiPublicUrl = "https://api.openworklabs.com"
  env.betterAuthUrl = "https://app.openworklabs.com"
  const input = { ...connection, callbackMode: "shared-v1" as const, recoverPublicOrigin: true }
  const proxy = "https://app.openworklabs.com/api/den/v1/mcp-connections/oauth/callback"
  assert.equal(externalMcpCompatibleCallbackUrl({ ...input, registeredRedirectUri: proxy }), proxy)
  assert.equal(externalMcpCompatibleCallbackUrl({ ...input, registeredRedirectUri: "https://old.example.test/v1/mcp-connections/oauth/callback" }), "https://api.openworklabs.com/v1/mcp-connections/oauth/callback")
})
