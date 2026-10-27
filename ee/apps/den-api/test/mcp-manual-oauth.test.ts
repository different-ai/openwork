import assert from "node:assert/strict"
import { test } from "node:test"
import { createEnterpriseMcpClient, discoverConnectionRequirements, manualOAuthEndpointsSchema, manualOAuthState, oauthIssuerMismatchMessage } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpOAuthPersistence } from "@openwork/enterprise-mcp-client"
import { createExternalMcpIdentityBinding, matchesLegacyExternalMcpOAuthStateIdentityBinding } from "../src/capability-sources/external-mcp-oauth-state-identity.js"

const endpoints = { authorizationEndpoint: "https://identity.example/authorize?tenant=synthetic", tokenEndpoint: "https://identity.example/token" }
const resource = "https://resource.example/mcp/team"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

for (const value of [
  {}, { authorizationEndpoint: endpoints.authorizationEndpoint }, { tokenEndpoint: endpoints.tokenEndpoint },
  { ...endpoints, tokenEndpoint: "not a URL" },
  { ...endpoints, tokenEndpoint: "http://identity.example/token" },
  { ...endpoints, authorizationEndpoint: "javascript:alert(1)" },
  { ...endpoints, tokenEndpoint: "https://user:secret@identity.example/token" },
  { ...endpoints, tokenEndpoint: "https://identity.example/token#fragment" },
  { ...endpoints, tokenEndpoint: "file:///tmp/token" },
]) test(`manual endpoint validation rejects ${JSON.stringify(value)}`, () => assert.equal(manualOAuthEndpointsSchema.safeParse(value).success, false))

test("manual endpoints accept HTTPS cross-host pairs and localhost development only", () => {
  assert.deepEqual(manualOAuthEndpointsSchema.parse(endpoints), endpoints)
  assert.ok(manualOAuthEndpointsSchema.safeParse({ authorizationEndpoint: "http://localhost:1234/authorize", tokenEndpoint: "http://127.0.0.1:1234/token" }).success)
  assert.equal(manualOAuthState(endpoints, resource).resourceMetadata?.resource, resource)
  assert.deepEqual(manualOAuthState(endpoints, resource).authorizationServerMetadata?.code_challenge_methods_supported, ["S256"])
})

function persistence(): EnterpriseMcpOAuthPersistence {
  return {
    clientRegistrations: { load: async () => ({ clientInformation: { client_id: "exp-mcpmanual-client" }, revision: "1", source: "pre-registered" }), save: async () => { throw new Error("No registration expected") }, invalidate: async () => {} },
    credentials: { load: async () => undefined, save: async () => { throw new Error("No tokens expected") }, invalidate: async () => {} },
    authorizations: { begin: async () => {}, load: async () => undefined, invalidate: async () => {} },
    discovery: { load: async () => { throw new Error("Manual mode must not load stale discovery") }, save: async () => { throw new Error("Manual mode must not save discovery") }, invalidate: async () => {} },
  }
}

test("manual endpoint selection skips all discovery and pins resource and S256", async () => {
  const calls: string[] = []
  const client = createEnterpriseMcpClient({ fetch: async (url) => { calls.push(String(url)); return new Response(null, { status: 302, headers: { location: "https://login.example/ignored" } }) } })
  const result = await client.connect({ connection: { id: "exp-mcpmanual-unit", serverUrl: resource, authorization: { type: "oauth", persistence: persistence(), configuration: { applicationType: "web", manualOAuthEndpoints: endpoints } } }, redirectUri: "https://client.example/callback", authorizationId: "exp-mcpmanual-state" })
  assert.equal(result.status, "needs_auth")
  if (result.status !== "needs_auth") throw new Error("Expected sign-in")
  const url = new URL(result.authorizeUrl)
  assert.equal(url.origin + url.pathname, "https://identity.example/authorize")
  assert.equal(url.searchParams.get("tenant"), "synthetic")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("resource"), resource)
  assert.deepEqual(calls, [resource])
})

test("issuer mismatch prefill is extracted read-only, never accepted as a trusted server", async () => {
  const requests: string[] = []
  const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: async (url) => {
    requests.push(String(url))
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [resource] })
    if (String(url) === "https://resource.example/.well-known/oauth-authorization-server/mcp/team") return json({ issuer: "https://resource.example", authorization_endpoint: endpoints.authorizationEndpoint, token_endpoint: endpoints.tokenEndpoint, response_types_supported: ["code"] })
    return json({}, 404)
  } })
  assert.deepEqual(result.authentication.authorizationServers, [])
  assert.deepEqual(result.publishedSignInAddresses, [{ ...endpoints, advertisedIssuer: resource, metadataIssuer: "https://resource.example/" }])
  assert.ok(result.warnings.some(warning => warning.code === "oauth_issuer_mismatch" && warning.message.includes("OpenWork stopped for security")))
  assert.equal(requests.some(url => new URL(url).origin === "https://identity.example"), false)
})

test("manual endpoints reject credential-like query keys but preserve public routing parameters", () => {
  const sensitive = ["client_secret", "access_token", "refresh_token", "id_token", "api_key", "X-API-Key", "password", "token", "code_verifier", "x-amz-signature", "client%5Fsecret", "%2563lient_secret", "client_secret_value", "api-key-value"]
  for (const key of sensitive) {
    for (const field of ["authorizationEndpoint", "tokenEndpoint"]) {
      assert.equal(manualOAuthEndpointsSchema.safeParse({ ...endpoints, [field]: `https://identity.example/oauth?${key}=exp-mcpmanual-private-value` }).success, false, `${field}: ${key}`)
    }
  }
  assert.ok(manualOAuthEndpointsSchema.safeParse({ ...endpoints, authorizationEndpoint: "https://identity.example/authorize?tenant=synthetic&client_id=public-client&country_code=GB" }).success)
})

test("issuer-mismatch prefill never returns credential-bearing endpoint queries", async () => {
  for (const field of ["authorization_endpoint", "token_endpoint"]) {
    const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: async (url) => {
      if (String(url) === resource) return new Response(null, { status: 401 })
      if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [resource] })
      if (String(url) === "https://resource.example/.well-known/oauth-authorization-server/mcp/team") return json({ issuer: "https://resource.example", authorization_endpoint: endpoints.authorizationEndpoint, token_endpoint: endpoints.tokenEndpoint, [field]: "https://identity.example/oauth?client_secret=exp-mcpmanual-metadata-private" , response_types_supported: ["code"] })
      return json({}, 404)
    } })
    assert.equal(result.publishedSignInAddresses, undefined)
    assert.deepEqual(result.authentication.authorizationServers, [])
    assert.ok(result.warnings.some(warning => warning.code === "oauth_issuer_mismatch"))
    assert.doesNotMatch(JSON.stringify(result), /exp-mcpmanual-metadata-private|client_secret=/)
  }
})

test("unverified issuer labels omit credentials and queries without changing strict verification", async () => {
  const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: async (url) => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [resource] })
    if (String(url) === "https://resource.example/.well-known/oauth-authorization-server/mcp/team") return json({ issuer: "https://resource.example?access_token=exp-mcpmanual-issuer-private", authorization_endpoint: endpoints.authorizationEndpoint, token_endpoint: endpoints.tokenEndpoint, response_types_supported: ["code"] })
    return json({}, 404)
  } })
  assert.deepEqual(result.authentication.authorizationServers, [])
  assert.equal(result.publishedSignInAddresses?.[0]?.metadataIssuer, "https://resource.example/")
  assert.doesNotMatch(JSON.stringify(result), /exp-mcpmanual-issuer-private|access_token=/)
})

test("even issuer-consistent discovery omits credential-bearing service URLs", async () => {
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: async (url) => {
      if (String(url) === resource) return new Response(null, { status: 401 })
      if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: ["https://identity.example"] })
      if (String(url) === "https://identity.example/.well-known/oauth-authorization-server") return json({ issuer: "https://identity.example", authorization_endpoint: endpoints.authorizationEndpoint, token_endpoint: endpoints.tokenEndpoint, [field]: "https://identity.example/oauth?access_token=exp-mcpmanual-consistent-private", response_types_supported: ["code"] })
      return json({}, 404)
    } })
    assert.deepEqual(result.authentication.authorizationServers, [])
    assert.equal(result.publishedSignInAddresses, undefined)
    assert.doesNotMatch(JSON.stringify(result), /exp-mcpmanual-consistent-private|access_token=/)
    assert.ok(result.warnings.some(warning => warning.code === "oauth_sign_in_addresses_unsafe"))
  }
})

test("endpoint configuration is part of the state and in-flight credential binding", () => {
  const base = { id: "exp-mcpmanual-identity", kind: "external_mcp", url: resource, authType: "oauth", credentialMode: "per_member" } satisfies Parameters<typeof createExternalMcpIdentityBinding>[0]
  const bound = createExternalMcpIdentityBinding({ ...base, oauthConfiguration: { manualOAuthEndpoints: endpoints } }, "synthetic-secret")
  assert.notEqual(bound, createExternalMcpIdentityBinding(base, "synthetic-secret"))
  const legacy = Buffer.from(JSON.stringify([resource, "oauth", "per_member"])).toString("base64url")
  assert.equal(matchesLegacyExternalMcpOAuthStateIdentityBinding(base, legacy), true)
  assert.equal(matchesLegacyExternalMcpOAuthStateIdentityBinding({ ...base, oauthConfiguration: { manualOAuthEndpoints: endpoints } }, legacy), false)
  assert.equal(matchesLegacyExternalMcpOAuthStateIdentityBinding({ ...base, oauthConfiguration: { manualOAuthEndpoints: endpoints } }, bound), false)
  assert.notEqual(bound, createExternalMcpIdentityBinding({ ...base, oauthConfiguration: { manualOAuthEndpoints: { ...endpoints, tokenEndpoint: `${endpoints.tokenEndpoint}?revision=2` } } }, "synthetic-secret"))
  assert.notEqual(bound, createExternalMcpIdentityBinding({ ...base, oauthConfiguration: { manualOAuthEndpoints: { ...endpoints, authorizationEndpoint: `${endpoints.authorizationEndpoint}&revision=2` } } }, "synthetic-secret"))
})

test("issuer diagnostics explain both identifiers without leaking URL credentials or query values", () => {
  const message = oauthIssuerMismatchMessage("https://user:secret@service.example/mcp?token=private", "https://service.example/#private")
  assert.match(message, /names https:\/\/service.example\/mcp/)
  assert.match(message, /identifies itself as https:\/\/service.example\//)
  assert.match(message, /Sign-in addresses/)
  assert.doesNotMatch(message, /secret|private|user:/)
})
