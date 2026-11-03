import assert from "node:assert/strict"
import { test } from "node:test"
import {
  externalMcpRequestHeaderNames,
  mergeExternalMcpRequestHeaderUpdate,
  parseStoredExternalMcpRequestHeaders,
  resolveRequestHeaderUpdate,
  serializeExternalMcpRequestHeaders,
  validateExternalMcpRequestHeaders,
  withExternalMcpRequestHeaders,
  type ExternalMcpFetch,
} from "../src/capability-sources/external-mcp-request-headers.ts"

function failureMessage(result: { ok: true } | { ok: false; message: string }): string {
  assert.equal(result.ok, false)
  return result.ok ? "" : result.message
}

test("valid headers pass and are copied", () => {
  const result = validateExternalMcpRequestHeaders([
    { name: "X-Tenant-Id", value: "tenant-1" },
    { name: "x-api-key", value: "secret value" },
  ], "oauth")
  assert.deepEqual(result, { ok: true, headers: [{ name: "X-Tenant-Id", value: "tenant-1" }, { name: "x-api-key", value: "secret value" }] })
})

test("header names must be RFC 7230 tokens of at most 64 characters", () => {
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "Bad Name", value: "v" }], "none")), /"Bad Name" is not a valid request header name/)
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "X-Tenant:", value: "v" }], "none")), /not a valid request header name/)
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "", value: "v" }], "none")), /needs a name/)
  assert.equal(validateExternalMcpRequestHeaders([{ name: "a".repeat(64), value: "v" }], "none").ok, true)
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "a".repeat(65), value: "v" }], "none")), /too long/)
})

test("values are 1-4096 characters with no CR, LF or NUL, and are never echoed", () => {
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "X-A", value: "" }], "none")), /Enter a value for the request header "X-A"/)
  assert.equal(validateExternalMcpRequestHeaders([{ name: "X-A", value: "v".repeat(4096) }], "none").ok, true)
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "X-A", value: "v".repeat(4097) }], "none")), /too long/)
  for (const value of ["secret\r\nX-Injected: 1", "secret\nmore", "secret\0"]) {
    const message = failureMessage(validateExternalMcpRequestHeaders([{ name: "X-A", value }], "none"))
    assert.match(message, /line breaks/)
    assert.doesNotMatch(message, /secret/)
  }
})

test("names are unique case-insensitively and at most four headers are allowed", () => {
  assert.match(failureMessage(validateExternalMcpRequestHeaders([
    { name: "X-Tenant", value: "a" },
    { name: "x-tenant", value: "b" },
  ], "none")), /"x-tenant" is listed more than once/)
  const five = ["A", "B", "C", "D", "E"].map((name) => ({ name: `X-${name}`, value: "v" }))
  assert.match(failureMessage(validateExternalMcpRequestHeaders(five, "none")), /up to 4/)
})

test("reserved names are rejected case-insensitively", () => {
  for (const name of [
    "Host", "content-length", "Content-Type", "ACCEPT", "connection", "keep-alive", "transfer-encoding", "te",
    "trailer", "upgrade", "proxy-authorization", "proxy-connection", "cookie", "Mcp-Session-Id",
    "mcp-protocol-version", "last-event-id", "X-OpenWork-Anything", "x-openwork-",
  ]) {
    assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name, value: "v" }], "none")), new RegExp(`"${name}" is set by OpenWork`))
  }
})

test("authorization is OpenWork's for OAuth and API-key connections only", () => {
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "Authorization", value: "Bearer x" }], "oauth")), /"Authorization" is set by OpenWork/)
  assert.match(failureMessage(validateExternalMcpRequestHeaders([{ name: "authorization", value: "Bearer x" }], "apikey")), /set by OpenWork/)
  assert.equal(validateExternalMcpRequestHeaders([{ name: "Authorization", value: "Bearer x" }], "none").ok, true)
  assert.equal(validateExternalMcpRequestHeaders([{ name: "Authorization", value: "Bearer x" }], "discover").ok, true)
})

test("stored headers round-trip and only names are exposed", () => {
  const stored = serializeExternalMcpRequestHeaders([{ name: "X-Tenant", value: "secret" }])
  assert.deepEqual(parseStoredExternalMcpRequestHeaders(stored), [{ name: "X-Tenant", value: "secret" }])
  assert.deepEqual(externalMcpRequestHeaderNames(stored), ["X-Tenant"])
  assert.equal(serializeExternalMcpRequestHeaders([]), null)
  assert.deepEqual(parseStoredExternalMcpRequestHeaders(null), [])
  assert.deepEqual(parseStoredExternalMcpRequestHeaders("not json"), [])
  assert.deepEqual(parseStoredExternalMcpRequestHeaders(JSON.stringify([{ name: 1 }, { name: "X-A", value: "v" }])), [{ name: "X-A", value: "v" }])
})

test("update: omitted keeps, array replaces, missing value keeps the stored value by name", () => {
  const stored = [{ name: "X-Tenant", value: "t-secret" }, { name: "X-Region", value: "eu" }]
  assert.deepEqual(mergeExternalMcpRequestHeaderUpdate(stored, undefined), { ok: true, headers: stored })
  assert.deepEqual(mergeExternalMcpRequestHeaderUpdate(stored, []), { ok: true, headers: [] })
  assert.deepEqual(
    mergeExternalMcpRequestHeaderUpdate(stored, [{ name: "x-tenant" }, { name: "X-New", value: "n" }]),
    { ok: true, headers: [{ name: "x-tenant", value: "t-secret" }, { name: "X-New", value: "n" }] },
  )
  assert.deepEqual(
    mergeExternalMcpRequestHeaderUpdate(stored, [{ name: "X-Region", value: "us" }]),
    { ok: true, headers: [{ name: "X-Region", value: "us" }] },
  )
  assert.match(failureMessage(mergeExternalMcpRequestHeaderUpdate(stored, [{ name: "X-Unknown" }])), /"X-Unknown"\. No value is saved/)
})

test("resolveRequestHeaderUpdate reports changes and validates against the new sign-in method", () => {
  const stored = serializeExternalMcpRequestHeaders([{ name: "Authorization", value: "Bearer s" }, { name: "X-Tenant", value: "t" }])
  assert.deepEqual(
    resolveRequestHeaderUpdate({ stored, update: undefined, authType: "none", serverChanged: false }),
    { ok: true, headers: [{ name: "Authorization", value: "Bearer s" }, { name: "X-Tenant", value: "t" }], changed: false },
  )
  assert.deepEqual(
    resolveRequestHeaderUpdate({ stored, update: [{ name: "Authorization" }, { name: "X-Tenant" }], authType: "none", serverChanged: false }),
    { ok: true, headers: [{ name: "Authorization", value: "Bearer s" }, { name: "X-Tenant", value: "t" }], changed: false },
  )
  const cleared = resolveRequestHeaderUpdate({ stored, update: [], authType: "none", serverChanged: false })
  assert.deepEqual(cleared, { ok: true, headers: [], changed: true })
  // Switching to an API key while keeping a stored Authorization header is refused.
  assert.match(failureMessage(resolveRequestHeaderUpdate({ stored, update: undefined, authType: "apikey", serverChanged: false })), /"Authorization" is set by OpenWork/)
  assert.deepEqual(
    resolveRequestHeaderUpdate({ stored: null, update: undefined, authType: "oauth", serverChanged: true }),
    { ok: true, headers: [], changed: false },
  )
})

test("saved values are never carried to a different server", () => {
  const stored = serializeExternalMcpRequestHeaders([{ name: "X-Tenant", value: "t" }])
  assert.match(failureMessage(resolveRequestHeaderUpdate({ stored, update: undefined, authType: "none", serverChanged: true })), /server address changed/)
  assert.match(failureMessage(resolveRequestHeaderUpdate({ stored, update: [{ name: "X-Tenant" }], authType: "none", serverChanged: true })), /server address changed/)
  assert.deepEqual(
    resolveRequestHeaderUpdate({ stored, update: [{ name: "X-Tenant", value: "new" }], authType: "none", serverChanged: true }),
    { ok: true, headers: [{ name: "X-Tenant", value: "new" }], changed: true },
  )
  assert.deepEqual(resolveRequestHeaderUpdate({ stored, update: [], authType: "none", serverChanged: true }), { ok: true, headers: [], changed: true })
})

function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers; redirect: RequestRedirect | undefined }> = []
  const fetchImpl: ExternalMcpFetch = async (url, init) => {
    calls.push({ url: url instanceof URL ? url.href : url, headers: new Headers(init?.headers), redirect: init?.redirect })
    return new Response("{}", { status: 200 })
  }
  return { calls, fetchImpl }
}

test("the fetch wrapper only adds headers to the MCP server URL itself", async () => {
  const { calls, fetchImpl } = recordingFetch()
  const wrapped = withExternalMcpRequestHeaders(fetchImpl, "https://mcp.example.com/mcp", [
    { name: "X-Tenant", value: "t-secret" },
  ])
  await wrapped("https://mcp.example.com/mcp", { method: "POST", headers: { "content-type": "application/json" } })
  await wrapped(new URL("https://mcp.example.com/mcp?session=1"))
  await wrapped("https://mcp.example.com/.well-known/oauth-protected-resource/mcp")
  await wrapped("https://mcp.example.com/.well-known/oauth-authorization-server")
  await wrapped("https://auth.example.com/token", { method: "POST" })
  await wrapped("https://mcp.example.com:8443/mcp")
  await wrapped("http://mcp.example.com/mcp")

  assert.equal(calls[0]?.headers.get("x-tenant"), "t-secret")
  assert.equal(calls[0]?.headers.get("content-type"), "application/json")
  assert.equal(calls[0]?.redirect, "manual")
  assert.equal(calls[1]?.headers.get("x-tenant"), "t-secret")
  for (const call of calls.slice(2)) {
    assert.equal(call.headers.get("x-tenant"), null, call.url)
  }
})

test("OpenWork's own authorization wins over a custom one", async () => {
  const { calls, fetchImpl } = recordingFetch()
  const wrapped = withExternalMcpRequestHeaders(fetchImpl, "https://mcp.example.com/mcp", [
    { name: "Authorization", value: "Bearer custom" },
    { name: "X-Tenant", value: "t" },
  ])
  await wrapped("https://mcp.example.com/mcp", { headers: { authorization: "Bearer openwork" }, redirect: "error" })
  await wrapped("https://mcp.example.com/mcp")
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer openwork")
  assert.equal(calls[0]?.headers.get("x-tenant"), "t")
  assert.equal(calls[0]?.redirect, "error")
  assert.equal(calls[1]?.headers.get("authorization"), "Bearer custom")
})

test("no headers leaves the fetch untouched", () => {
  const { fetchImpl } = recordingFetch()
  assert.equal(withExternalMcpRequestHeaders(fetchImpl, "https://mcp.example.com/mcp", []), fetchImpl)
})

test("discovery sends request headers only to the MCP URL, not to metadata or sign-in addresses", async () => {
  const { discoverConnectionRequirements } = await import("@openwork/enterprise-mcp-client")
  const seen: Array<{ url: string; tenant: string | null }> = []
  const fakeNetwork: ExternalMcpFetch = async (url, init) => {
    const href = url instanceof URL ? url.href : url
    seen.push({ url: href, tenant: new Headers(init?.headers).get("x-tenant") })
    if (href === "https://mcp.example.com/mcp") {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' },
      })
    }
    if (href.startsWith("https://mcp.example.com/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] })
    }
    if (href.startsWith("https://auth.example.com/.well-known/")) {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    return new Response("not found", { status: 404 })
  }
  await discoverConnectionRequirements({
    serverUrl: "https://mcp.example.com/mcp",
    fetch: withExternalMcpRequestHeaders(fakeNetwork, "https://mcp.example.com/mcp", [{ name: "X-Tenant", value: "t-secret" }]),
  })
  const mcpCalls = seen.filter((call) => call.url === "https://mcp.example.com/mcp")
  const otherCalls = seen.filter((call) => call.url !== "https://mcp.example.com/mcp")
  assert.ok(mcpCalls.length > 0)
  assert.ok(otherCalls.length > 0)
  for (const call of mcpCalls) assert.equal(call.tenant, "t-secret")
  for (const call of otherCalls) assert.equal(call.tenant, null, call.url)
})
