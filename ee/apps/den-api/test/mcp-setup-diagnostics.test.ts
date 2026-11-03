import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ExternalMcpDiagnosticTracker,
  createExternalMcpDiagnosticFetch,
} from "../src/capability-sources/external-mcp-diagnostics.ts"

const endpoint = "https://gateway.example/mcp"
const sentinel = "fixture-private-key-0123456789"

/** Runs one initialize request against a canned answer and returns what the person and logs would see. */
async function initializeFailure(status: number, body: string, contentType = "text/plain") {
  const tracker = new ExternalMcpDiagnosticTracker("ref-fixture", { authType: "apikey", credentialMode: "shared" })
  const fetch = createExternalMcpDiagnosticFetch({
    endpoint,
    tracker,
    fetch: async () => new Response(body, { status, headers: { "content-type": contentType } }),
  })
  tracker.begin("MCP_INITIALIZE")
  await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${sentinel}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  })
  return tracker.error(new Error(`Streamable HTTP error: ${body}`), "MCP_INITIALIZE").diagnostic
}

test("a DNS failure names the server network, suggests checks, and promises nothing", () => {
  const tracker = new ExternalMcpDiagnosticTracker("ref-dns")
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND private-host.example"), { code: "ENOTFOUND" })
  const diagnostic = tracker.error(new TypeError("fetch failed", { cause }), "MCP_INITIALIZE")
  assert.equal(diagnostic.diagnostic.phase, "NETWORK_DNS")
  assert.match(diagnostic.diagnostic.message, /server network could not resolve/)
  assert.match(diagnostic.diagnostic.message, /hostname is correct and publicly reachable/)
  assert.match(diagnostic.diagnostic.message, /just turned on.*try again later/)
  assert.doesNotMatch(diagnostic.diagnostic.message, /will (?:work|fix|resolve)/)
  assert.doesNotMatch(diagnostic.diagnostic.message, /private-host/)
})

test("a gateway that says its sessions are used up is reported as a session limit, with no body or key", async () => {
  const diagnostic = await initializeFailure(503, `Too many sessions for key ${sentinel}`)
  assert.equal(diagnostic.code, "MCP_SESSION_LIMIT")
  assert.equal(diagnostic.retryable, true)
  assert.match(diagnostic.message, /limit of open sessions/)
  assert.match(diagnostic.operatorAction, /raise its session limit/)
  assert.ok(!JSON.stringify(diagnostic).includes(sentinel))
})

test("generic initialize refusals keep their status and are not guessed to be session limits", async () => {
  const unavailable = await initializeFailure(503, "upstream unavailable")
  assert.equal(unavailable.code, "MCP_HTTP_503")
  assert.equal(unavailable.httpStatus, 503)
  assert.match(unavailable.message, /failed or was unavailable while starting a session \(HTTP 503\)/)

  const throttled = await initializeFailure(429, "slow down")
  assert.equal(throttled.code, "MCP_HTTP_429")
  assert.match(throttled.message, /rate limiting OpenWork and did not start a session \(HTTP 429\)/)

  const refused = await initializeFailure(400, "bad request")
  assert.match(refused.message, /refused to start a session \(HTTP 400\)/)
  for (const diagnostic of [unavailable, throttled, refused]) assert.notEqual(diagnostic.code, "MCP_SESSION_LIMIT")
})

test("a rejected key is an authentication failure for the organization's admin, never echoed", async () => {
  const diagnostic = await initializeFailure(401, JSON.stringify({ message: `invalid key ${sentinel}` }), "application/json")
  assert.equal(diagnostic.phase, "AUTH_RESOURCE_VALIDATION")
  assert.equal(diagnostic.actionOwner, "organization_admin")
  assert.match(diagnostic.message, /rejected the supplied authorization \(HTTP 401\)/)
  assert.ok(!diagnostic.message.includes(sentinel))
})
