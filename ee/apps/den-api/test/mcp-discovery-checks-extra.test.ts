import assert from "node:assert/strict"
import { test } from "node:test"
import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpDiscoveryCheck } from "@openwork/enterprise-mcp-client"

const resource = "https://resource.example/mcp"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const metadata = { issuer: "https://resource.example", authorization_endpoint: "https://resource.example/authorize", token_endpoint: "https://resource.example/token", response_types_supported: ["code"], client_id_metadata_document_supported: true }

test("a discovery alias passes only after independently validating the canonical issuer", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const requests: string[] = []
  const result = await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    requests.push(String(url))
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [resource] })
    if (String(url).includes("oauth-authorization-server")) return json(metadata)
    return json({}, 404)
  } })
  assert.equal(result.authentication.authorizationServers[0]?.issuer, metadata.issuer)
  assert.deepEqual(checks.at(-1), { id: "provider", status: "passed", httpStatus: 200 })
  assert.ok(requests.includes("https://resource.example/.well-known/oauth-authorization-server/mcp"))
  assert.ok(requests.includes("https://resource.example/.well-known/oauth-authorization-server"))
})

test("disconnect fences a noncooperative metadata fetch and cancels its late response", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const cancelled = Promise.withResolvers<void>()
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const operation = discoverConnectionRequirements({ serverUrl: resource, signal: controller.signal, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    started.resolve()
    return response.promise
  } })
  await started.promise
  controller.abort()
  await assert.rejects(operation)
  const count = checks.length
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve() } })))
  await cancelled.promise
  assert.equal(checks.length, count)
  assert.deepEqual(checks.at(-1), { id: "resource", status: "running" })
})

test("whole-discovery deadline also cancels a stalled response body", async () => {
  const cancelled = Promise.withResolvers<void>()
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, timeoutMs: 20, onCheck: check => checks.push(check), fetch: async () => new Response(new ReadableStream({ cancel() { cancelled.resolve() } }), { headers: { "content-type": "application/json" } }) })
  await cancelled.promise
  assert.deepEqual(checks[1], { id: "server", status: "failed", httpStatus: 200, code: "unavailable" })
})

test("bounded issuer discovery cannot report success for unchecked candidates", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, maxAuthorizationServers: 1, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [metadata.issuer, "https://unchecked.example"] })
    if (String(url).includes("oauth-authorization-server")) return json(metadata)
    return json({}, 404)
  } })
  assert.deepEqual(checks.at(-1), { id: "provider", status: "failed", code: "unsupported" })
})

test("404 discovery fallbacks do not mask the resource and provider documents validated with HTTP 200", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  const requests: string[] = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    const address = String(url)
    requests.push(address)
    if (address === resource) return new Response(null, { status: 401 })
    if (address === "https://resource.example/.well-known/oauth-protected-resource") return json({ resource, authorization_servers: [metadata.issuer] })
    if (address === "https://resource.example/.well-known/openid-configuration") return json({ ...metadata, jwks_uri: "https://resource.example/keys", subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] })
    return json({}, 404)
  } })
  assert.ok(requests.includes("https://resource.example/.well-known/oauth-protected-resource/mcp"))
  assert.ok(requests.includes("https://resource.example/.well-known/oauth-authorization-server"))
  assert.ok(checks.some(check => check.id === "resource" && check.status === "passed" && check.httpStatus === 200))
  assert.deepEqual(checks.at(-1), { id: "provider", status: "passed", httpStatus: 200 })
})

test("an unrecovered alias mismatch keeps its HTTP 200 rather than later canonical 404s", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [resource] })
    if (String(url) === "https://resource.example/.well-known/oauth-authorization-server/mcp") return json(metadata)
    return json({}, 404)
  } })
  assert.deepEqual(checks.at(-1), { id: "provider", status: "failed", httpStatus: 200, code: "issuer_mismatch" })
})

test("mixed provider failure HTTP statuses are omitted rather than borrowing another issuer's result", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: ["https://wrong.example", "https://unavailable.example", metadata.issuer] })
    if (String(url).startsWith("https://unavailable.example")) return json({}, 500)
    return json(metadata)
  } })
  assert.deepEqual(checks.at(-1), { id: "provider", status: "failed", code: "issuer_mismatch" })
})

test("successful issuer aggregates use the final validated document's status", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [metadata.issuer, "https://last.example"] })
    if (String(url).startsWith("https://last.example")) return json({ ...metadata, issuer: "https://last.example" }, 201)
    return json(metadata)
  } })
  assert.deepEqual(checks.at(-1), { id: "provider", status: "passed", httpStatus: 201 })
})

test("valid issuer document without usable sign-in endpoints is not provider success", async () => {
  const checks: EnterpriseMcpDiscoveryCheck[] = []
  await discoverConnectionRequirements({ serverUrl: resource, onCheck: check => checks.push(check), fetch: async url => {
    if (String(url) === resource) return new Response(null, { status: 401 })
    if (String(url).includes("oauth-protected-resource")) return json({ resource, authorization_servers: [metadata.issuer] })
    if (String(url).includes("oauth-authorization-server")) return json({ issuer: metadata.issuer, response_types_supported: ["code"] })
    return json({}, 404)
  } })
  assert.notEqual(checks.at(-1)?.status, "passed")
})
