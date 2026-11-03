import assert from "node:assert/strict"
import { test } from "node:test"
import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpFetch } from "@openwork/enterprise-mcp-client"
import { automaticOAuthSetupDenial, CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE, oauthScopeSelectionChanged } from "../src/capability-sources/external-mcp-oauth-setup-guard.js"
import { withExternalMcpRequestHeaders } from "../src/capability-sources/external-mcp-request-headers.js"

const resource = "https://resource.example/mcp/readonly"
const issuer = "https://identity.example"
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
function discoveryFetch(mismatch: boolean, scopes?: string[]): EnterpriseMcpFetch {
  return async (url) => {
    if (String(url) === resource) return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource", scope="read write"' } })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [issuer], ...(scopes === undefined ? {} : { scopes_supported: scopes }) })
    if (String(url).startsWith(issuer)) return json({ issuer: mismatch ? "https://wrong.example" : issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"], client_id_metadata_document_supported: true })
    return json({}, 404)
  }
}

test("strict issuer mismatch denies automatic setup without disclosing documents or addresses", async () => {
  const result = await automaticOAuthSetupDenial({ serverUrl: resource, fetch: discoveryFetch(true) })
  assert.equal(result, CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE)
  assert.doesNotMatch(result ?? "", /https:|identity\.example|wrong\.example/)
});

test("matching strict metadata passes and network failure does not manufacture a mismatch", async () => {
  assert.equal(await automaticOAuthSetupDenial({ serverUrl: resource, fetch: discoveryFetch(false) }), null)
  assert.equal(await automaticOAuthSetupDenial({ serverUrl: resource, fetch: async () => { throw new Error("private header or URL") } }), null)
});

test("save guard uses the same header-scoped discovery boundary: headers reach only the MCP endpoint", async () => {
  const seen: string[] = []
  const fetch = discoveryFetch(true)
  const denial = await automaticOAuthSetupDenial({ serverUrl: resource, fetch: withExternalMcpRequestHeaders(async (url, init) => {
    if (new Headers(init?.headers).has("X-Setup-Key")) seen.push(String(url))
    return fetch(url, init)
  }, resource, [{ name: "X-Setup-Key", value: "synthetic-only" }]) })
  assert.equal(denial, CUSTOM_OAUTH_ISSUER_REVIEW_MESSAGE)
  assert.ok(seen.length > 0)
  assert.ok(seen.every(url => url === resource))
});

test("resource scope advertisement survives separately without changing legacy required/recommended semantics", async () => {
  const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: discoveryFetch(false, ["read"]) })
  assert.deepEqual(result.authentication.requiredScopes, ["read", "write"])
  assert.deepEqual(result.authentication.recommendedScopes, ["read", "write"])
  assert.deepEqual(result.authentication.resourceScopesSupported, ["read"])
  const absent = await discoverConnectionRequirements({ serverUrl: resource, fetch: discoveryFetch(false) })
  assert.equal(Object.hasOwn(absent.authentication, "resourceScopesSupported"), false)
});

test("the guard preserves independently verified resource discovery aliases", async () => {
  const aliasResource = "https://resource.example/mcp"
  const calls: string[] = []
  const denial = await automaticOAuthSetupDenial({ serverUrl: aliasResource, fetch: async url => {
    calls.push(String(url))
    if (String(url) === aliasResource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource: aliasResource, authorization_servers: [aliasResource] })
    if (String(url).includes("oauth-authorization-server")) return json({ issuer: "https://resource.example", authorization_endpoint: "https://resource.example/authorize", token_endpoint: "https://resource.example/token", response_types_supported: ["code"], client_id_metadata_document_supported: true })
    return json({}, 404)
  } })
  assert.equal(denial, null)
  assert.ok(calls.includes("https://resource.example/.well-known/oauth-authorization-server/mcp"))
  assert.ok(calls.includes("https://resource.example/.well-known/oauth-authorization-server"))
})

test("scope ordering and duplicate scopes do not trigger another discovery", () => {
  assert.equal(oauthScopeSelectionChanged(["read", "write"], ["write", "read", "read"]), false)
  assert.equal(oauthScopeSelectionChanged(["read"], ["read", "write"]), true)
});
