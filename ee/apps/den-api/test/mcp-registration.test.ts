import assert from "node:assert/strict"
import { test } from "node:test"
import { isRegistrationRefusal, nextMcpRegistrationStatus, normalizeIssuer, redactEndpoint } from "../src/mcp-registration/status-rules.js"

// probe.ts and sign-in.ts read env and open the database client at import time; satisfy the schema with synthetic
// unit-test values. Nothing here connects to a database.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/mcp_registration_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-mcp-registration-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-mcp-registration-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { attemptDynamicRegistration } = await import("../src/mcp-registration/probe.js")
const { signInRegistrationOutcome, authorizationServerFacts } = await import("../src/mcp-registration/sign-in.js")

test("a real registration result always sets the status", () => {
  assert.equal(nextMcpRegistrationStatus("dynamic_open", "refused"), "dynamic_refused")
  assert.equal(nextMcpRegistrationStatus("dynamic_refused", "registered_dynamic"), "dynamic_open")
  assert.equal(nextMcpRegistrationStatus(null, "registered_client_metadata"), "client_metadata")
  assert.equal(nextMcpRegistrationStatus(null, "no_registration_method"), "requires_client")
  assert.equal(nextMcpRegistrationStatus(null, "no_auth"), "no_auth")
})

test("metadata alone never claims registration is open, and an unreachable server keeps its status", () => {
  assert.equal(nextMcpRegistrationStatus(null, "metadata_only", { dynamicRegistrationSupported: true }), "unknown")
  assert.equal(nextMcpRegistrationStatus("dynamic_refused", "metadata_only", { dynamicRegistrationSupported: true }), "dynamic_refused")
  assert.equal(nextMcpRegistrationStatus(null, "metadata_only", { clientMetadataSupported: true }), "client_metadata")
  assert.equal(nextMcpRegistrationStatus(null, "metadata_only", { clientMetadataSupported: false, dynamicRegistrationSupported: false }), "requires_client")
  assert.equal(nextMcpRegistrationStatus("dynamic_refused", "unreachable"), "dynamic_refused")
  assert.equal(nextMcpRegistrationStatus(null, "unreachable"), "unknown")
})

test("only a 401 or 403 at client registration counts as a refusal", () => {
  assert.equal(isRegistrationRefusal({ phase: "AUTH_CLIENT_REGISTRATION", code: "MCP_HTTP_403", httpStatus: 403 }), true)
  assert.equal(isRegistrationRefusal({ phase: "AUTH_CLIENT_REGISTRATION", code: "MCP_HTTP_401" }), true)
  assert.equal(isRegistrationRefusal({ phase: "AUTH_CLIENT_REGISTRATION", code: "MCP_HTTP_500", httpStatus: 500 }), false)
  assert.equal(isRegistrationRefusal({ phase: "AUTH_TOKEN_EXCHANGE", code: "MCP_HTTP_403", httpStatus: 403 }), false)
})

test("issuers and endpoints are stored without queries, fragments or trailing slashes", () => {
  assert.equal(normalizeIssuer("https://api.figma.com/"), "https://api.figma.com")
  assert.equal(normalizeIssuer("https://auth.example/tenant/?x=1#y"), "https://auth.example/tenant")
  assert.equal(normalizeIssuer("not a url"), null)
  assert.equal(normalizeIssuer("javascript:alert(1)"), null)
  assert.equal(redactEndpoint("https://auth.example/register?token=secret"), "https://auth.example/register")
})

test("a sign-in start maps to an outcome only when it says something about registration", () => {
  const refused = { phase: "AUTH_CLIENT_REGISTRATION", code: "MCP_HTTP_403", httpStatus: 403 }
  assert.equal(signInRegistrationOutcome({ diagnostic: refused }), "refused")
  assert.equal(signInRegistrationOutcome({ diagnostic: { code: "MCP_OAUTH_CONFIGURATION_REQUIRED" } }), "no_registration_method")
  assert.equal(signInRegistrationOutcome({ diagnostic: { phase: "AUTH_TOKEN_EXCHANGE", code: "MCP_HTTP_500" } }), null)
  assert.equal(signInRegistrationOutcome({ registrationSource: "client-metadata" }), "registered_client_metadata")
  assert.equal(signInRegistrationOutcome({ registrationSource: "dynamic" }), "registered_dynamic")
  // An admin's own OAuth app says nothing about whether the provider accepts OpenWork.
  assert.equal(signInRegistrationOutcome({ registrationSource: "pre-registered" }), null)
  assert.equal(signInRegistrationOutcome({}), null)
})

test("the connection's saved discovery gives the issuer and what it advertises", () => {
  const facts = authorizationServerFacts({
    oauthConfiguration: {
      version: 1, authorizationServerIssuer: "https://configured.example", requestedScopes: [], callbackMode: "shared-v1",
      discovery: { authorizationServerMetadata: { issuer: "https://api.figma.com", registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" } },
    },
  })
  assert.deepEqual(facts, {
    issuer: "https://api.figma.com",
    registrationEndpoint: "https://api.figma.com/v1/oauth/mcp/register",
    clientMetadataSupported: false,
    dynamicRegistrationSupported: true,
  })
  assert.equal(authorizationServerFacts({ oauthConfiguration: null }).issuer, null)
})

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = []
  const impl = async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, authorization: headers.get("authorization") })
    const next = responses.shift() ?? { status: 404 }
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } })
  }
  return { impl, calls }
}

test("a refused registration is recorded as refused and never retried", async () => {
  const { impl, calls } = fakeFetch([{ status: 403 }])
  const attempt = await attemptDynamicRegistration({ registrationEndpoint: "https://auth.example/register", redirectUri: "https://den.example/v1/mcp-connections/oauth/callback", fetch: impl })
  assert.deepEqual(attempt, { outcome: "refused", httpStatus: 403, diagnosticCode: "MCP_HTTP_403" })
  assert.equal(calls.length, 1)
  // It registers exactly like a member's sign-in: OpenWork, our callback, public client.
  assert.deepEqual(calls[0]?.body, {
    redirect_uris: ["https://den.example/v1/mcp-connections/oauth/callback"],
    client_name: "OpenWork",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  })
})

test("an accepted registration is deleted again when the provider allows it", async () => {
  const { impl, calls } = fakeFetch([
    { status: 201, body: { client_id: "abc", registration_client_uri: "https://auth.example/register/abc", registration_access_token: "rat" } },
    { status: 204 },
  ])
  const attempt = await attemptDynamicRegistration({ registrationEndpoint: "https://auth.example/register", redirectUri: "https://den.example/cb", fetch: impl })
  assert.equal(attempt.outcome, "registered_dynamic")
  assert.equal(calls[1]?.method, "DELETE")
  assert.equal(calls[1]?.url, "https://auth.example/register/abc")
  assert.equal(calls[1]?.authorization, "Bearer rat")
})

test("other registration failures are not called refusals", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { error: "invalid_client_metadata" } }])
  const attempt = await attemptDynamicRegistration({ registrationEndpoint: "https://auth.example/register", redirectUri: "https://den.example/cb", fetch: impl })
  assert.deepEqual(attempt, { outcome: "metadata_only", httpStatus: 400, diagnosticCode: "MCP_HTTP_400" })
  const failing = async () => { throw new Error("network down") }
  assert.equal((await attemptDynamicRegistration({ registrationEndpoint: "https://auth.example/register", redirectUri: "https://den.example/cb", fetch: failing })).outcome, "unreachable")
})
