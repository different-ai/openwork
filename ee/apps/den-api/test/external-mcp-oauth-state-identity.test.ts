import { expect, test } from "bun:test"
import {
  createExternalMcpIdentityBinding,
  matchesLegacyExternalMcpOAuthStateIdentityBinding,
  type ExternalMcpOAuthStateIdentitySource,
} from "../src/capability-sources/external-mcp-oauth-state-identity.js"

const BINDING_SECRET = "deployment-stable-oauth-state-secret"
const externalMcpIdentityBinding = (source: ExternalMcpOAuthStateIdentitySource) =>
  createExternalMcpIdentityBinding(source, BINDING_SECRET)

test("OAuth state identity binding excludes connection credentials", () => {
  const connection = {
    id: "emc_01identitybinding",
    kind: "external_mcp",
    url: "https://mcp.example.test/api/",
    authType: "oauth",
    credentialMode: "per_member",
    apiKey: "secret-api-key",
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
  } satisfies ExternalMcpOAuthStateIdentitySource & {
    apiKey: string
    accessToken: string
    refreshToken: string
  }

  const binding = externalMcpIdentityBinding(connection)
  expect(externalMcpIdentityBinding({
    ...connection,
    apiKey: "different-api-key",
    accessToken: "different-access-token",
    refreshToken: "different-refresh-token",
  })).toBe(binding)
  expect(externalMcpIdentityBinding({ ...connection, url: "https://other.example.test/api" })).not.toBe(binding)
  expect(createExternalMcpIdentityBinding(connection, "a-different-deployment-secret")).not.toBe(binding)
  expect(binding).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(binding).toHaveLength(43)
})

test("OAuth state identity binding does not expose secret-like URL query values", () => {
  const secret = "sk-secret-query-token"
  const binding = externalMcpIdentityBinding({
    id: "emc_01querysecret",
    kind: "external_mcp",
    url: `https://mcp.example.test/api?access_token=${secret}`,
    authType: "oauth",
    credentialMode: "per_member",
  })

  expect(binding).toHaveLength(43)
  expect(binding).not.toContain(secret)
  expect(Buffer.from(binding, "base64url").toString("utf8")).not.toContain(secret)
})

test("OAuth state identity binding remains fixed length for maximum-length URLs", () => {
  const prefix = "https://mcp.example.test/api?access_token="
  const url = `${prefix}${"s".repeat(2_048 - prefix.length)}`
  const source = {
    id: "emc_01maxlength",
    kind: "external_mcp",
    url,
    authType: "oauth",
    credentialMode: "per_member",
  } satisfies ExternalMcpOAuthStateIdentitySource

  expect(url).toHaveLength(2_048)
  expect(externalMcpIdentityBinding(source)).toHaveLength(43)
  expect(externalMcpIdentityBinding({ ...source, url: `${url.slice(0, -1)}t` }))
    .not.toBe(externalMcpIdentityBinding(source))
})

test("signed OAuth callbacks can match pre-hash identity bindings without emitting them for new states", () => {
  const source = {
    id: "emc_01legacybinding",
    kind: "external_mcp",
    url: "https://mcp.example.test/api/",
    authType: "oauth",
    credentialMode: "per_member",
  } satisfies ExternalMcpOAuthStateIdentitySource
  const legacyBinding = Buffer.from(JSON.stringify([
    "https://mcp.example.test/api",
    "oauth",
    "per_member",
  ])).toString("base64url")
  // SHA-256 binding emitted immediately before deployment-keyed bindings.
  const previousDigestBinding = "zAHAL4Yvrvzm3ut1qYtgAgXztMNEzzL4gPpGAoIxX4Y"

  expect(matchesLegacyExternalMcpOAuthStateIdentityBinding(source, legacyBinding)).toBe(true)
  expect(matchesLegacyExternalMcpOAuthStateIdentityBinding(source, previousDigestBinding)).toBe(true)
  expect(matchesLegacyExternalMcpOAuthStateIdentityBinding(source, externalMcpIdentityBinding(source))).toBe(false)
  expect(matchesLegacyExternalMcpOAuthStateIdentityBinding({ ...source, authType: "none" }, legacyBinding)).toBe(false)
  expect(externalMcpIdentityBinding(source)).not.toBe(legacyBinding)
})
