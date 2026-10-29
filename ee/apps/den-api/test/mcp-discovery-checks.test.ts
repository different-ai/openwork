import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpDiscoveryCheck, EnterpriseMcpFetch } from "@openwork/enterprise-mcp-client"

const resource = "https://resource.example/mcp"
const issuer = "https://identity.example"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const metadata = (identity = issuer) => ({ issuer: identity, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"], client_id_metadata_document_supported: true })
const challenge = () => new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource/mcp"' } })
function oauthFetch(options: { mismatch?: boolean; mixed?: boolean; unsafe?: boolean } = {}): EnterpriseMcpFetch {
  return async (url) => {
    if (String(url) === resource) return challenge()
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: options.mixed ? [issuer, "https://other.example"] : [issuer] })
    if (String(url).startsWith(issuer) || String(url).startsWith("https://other.example")) return json({ ...metadata(options.mismatch ? "https://wrong.example" : issuer), ...(options.unsafe ? { token_endpoint: `${issuer}/token?client_secret=private-synthetic-value` } : {}) })
    return json({}, 404)
  }
}
const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
const anonymousFetch: EnterpriseMcpFetch = async (url, init) => {
  if (String(url) !== resource) return json({}, 404)
  if (init?.method !== "POST") return new Response(null, { status: 405 })
  const rpc = rpcSchema.parse(JSON.parse(String(init.body)))
  if (rpc.method === "server/discover") return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })
  if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } } })
  if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } })
  return new Response(null, { status: 202 })
}

test("progress starts before a real pending request and completes only after validated documents", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const calls: string[] = []
  const fetch = oauthFetch()
  const operation = discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async (url, init) => {
    calls.push(String(url))
    if (String(url) === resource) { started.resolve(); await release.promise }
    return fetch(url, init)
  } })
  await started.promise
  assert.deepEqual(checks, [{ id: "server", status: "running" }])
  release.resolve()
  const result = await operation
  assert.equal(result.authentication.kind, "oauth")
  assert.deepEqual(checks, [
    { id: "server", status: "running" },
    { id: "server", status: "passed", httpStatus: 401, code: "authentication_required" },
    { id: "resource", status: "running" }, { id: "resource", status: "passed", httpStatus: 200 },
    { id: "provider", status: "running" }, { id: "provider", status: "passed", httpStatus: 200 },
  ])
  assert.equal(calls.filter(url => url.includes("oauth-protected-resource")).length, 1)
  assert.equal(calls.filter(url => url.includes("oauth-authorization-server")).length, 1)
})

test("legacy negotiation success reports initialize 200, not modern 404 or initialized notification 202", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const requests: Array<{ method: string; status: number }> = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async (url, init) => {
    if (String(url) !== resource || init?.method !== "POST") return anonymousFetch(url, init)
    const rpc = rpcSchema.parse(JSON.parse(String(init.body)))
    const response = rpc.method === "server/discover" ? json({}, 404) : await anonymousFetch(url, init)
    requests.push({ method: rpc.method, status: response.status })
    return response
  } })
  assert.deepEqual(requests, [
    { method: "server/discover", status: 404 },
    { method: "initialize", status: 200 },
    { method: "notifications/initialized", status: 202 },
    { method: "tools/list", status: 200 },
  ])
  assert.deepEqual(checks[1], { id: "server", status: "passed", httpStatus: 200 })
})

test("anonymous initialization passes and missing optional metadata skips both sign-in phases", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: anonymousFetch, onCheck: check => checks.push(check) })
  assert.equal(result.server.initialize, "succeeded")
  assert.equal(result.authentication.kind, "none")
  assert.equal(checks.find(check => check.id === "server" && check.status !== "running")?.status, "passed")
  assert.deepEqual(checks.slice(-2), [{ id: "resource", status: "skipped", code: "not_required" }, { id: "provider", status: "skipped", code: "not_required" }])
})

for (const options of [{ mismatch: true }, { mixed: true }, { unsafe: true }]) test(`HTTP 200 is not provider validation: ${JSON.stringify(options)}`, async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, fetch: oauthFetch(options), onCheck: check => checks.push(check) })
  assert.deepEqual(checks.at(-1), { id: "provider", status: "failed", httpStatus: 200, code: options.unsafe ? "unsupported" : "issuer_mismatch" })
  assert.doesNotMatch(JSON.stringify(checks), /https:|private-synthetic-value|client_secret|authorize|token_endpoint/)
  for (const check of checks) assert.ok(Object.keys(check).every(key => ["id", "status", "httpStatus", "code"].includes(key)))
})

test("malformed successful HTTP response fails server as unsupported", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, fetch: async () => json({ unrelated: "private-network-body" }), onCheck: check => checks.push(check) })
  assert.deepEqual(checks[1], { id: "server", status: "failed", httpStatus: 200, code: "unsupported" })
  assert.doesNotMatch(JSON.stringify(checks), /private-network-body/)
})

test("authentication challenge without metadata fails resource instead of falsely completing it", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const result = await discoverConnectionRequirements({ serverUrl: resource, fetch: async url => String(url) === resource ? challenge() : json({}, 404), onCheck: check => checks.push(check) })
  assert.equal(result.authentication.kind, "manual_bearer")
  assert.ok(checks.some(check => check.id === "resource" && check.status === "failed" && check.code === "unavailable"))
})

test("unreachable and deadline failure produce real failed checks without additional network requests", async () => {
  for (const timeout of [false, true]) {
    const checks: EnterpriseMcpDiscoveryCheck[] = []
    let calls = 0
    const result = await discoverConnectionRequirements({ serverUrl: resource, timeoutMs: 20, onCheck: check => checks.push(check), fetch: async (_url, init) => {
      calls++
      if (!timeout) throw new Error("synthetic private network failure")
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error("Expected cancellation")
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    } })
    assert.equal(result.status, "unreachable")
    assert.deepEqual(checks[1], { id: "server", status: "failed", code: "unavailable" })
    assert.doesNotMatch(JSON.stringify(checks), /synthetic private/)
    if (timeout) assert.equal(calls, 1)
  }
})

test("disconnect aborts pending discovery and never calls progress again", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  let calls = 0
  const operation = discoverConnectionRequirements({ serverUrl: resource, signal: controller.signal, onCheck: check => checks.push(check), fetch: async (_url, init) => {
    calls++
    started.resolve()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("disconnected private detail")), { once: true }))
  } })
  await started.promise
  controller.abort()
  await assert.rejects(operation)
  assert.deepEqual(checks, [{ id: "server", status: "running" }])
  assert.equal(calls, 1)
})

test("progress is additive: callback and JSON callers get identical requirements and request sequence", async () => {
  const calls: string[][] = [[], []]
  const results = []
  for (const [index, requests] of calls.entries()) {
    const fetch = oauthFetch()
    results.push(await discoverConnectionRequirements({ serverUrl: resource, ...(index ? { onCheck: () => {} } : {}), fetch: (url, init) => { requests.push(String(url)); return fetch(url, init) } }))
  }
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(calls[0], calls[1])
})
