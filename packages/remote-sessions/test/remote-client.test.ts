import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteSessionTransport, RemoteSessionHttpError } from "../src/index.ts"
import type { Command, Inventory, Request } from "../src/index.ts"
const signal = () => new AbortController().signal
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }) }
const command: Command = { commandId: "cmd_test", kind: "remote_session_create", title: "Client test", prompt: null, model: null, expiresAt: 10_000 }
const request: Request = { requestId: "req_test", kind: "remote_session_request", commandId: command.commandId, sessionId: "ses_test",
  workspaceId: "workspace", engine: null, expiresAt: 10_000, action: "read", input: { from: "start", cursor: null, limit: 10 } }
const inventory: Inventory = { computer: { label: "Test computer", platform: "linux", appVersion: "0.0.0" }, workspaces: [{
  workspaceId: "workspace", name: "Test workspace", active: true, engine: "v2", defaultModel: null,
  models: [{ providerId: "test", modelId: "test", name: "Test model" }],
}] }

test("transport reads the token on every attempt, uses JSON, and refuses fetch redirects", async () => {
  let token = "old-token"
  const sent: Array<{ authorization: string | null; url: string; method: string; redirect: RequestRedirect; body: unknown }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const r = new globalThis.Request(input, init)
    sent.push({ authorization: r.headers.get("authorization"), url: r.url, method: r.method, redirect: r.redirect, body: await r.json() })
    return json({ command: { id: command.commandId, status: "delivered", sessionId: "ses_test", workspaceId: "workspace" } })
  }
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example/prefix", token: () => token, fetch: fetcher })
  const body = { status: "delivered", sessionId: "ses_test", workspaceId: "workspace" } satisfies Parameters<typeof client.complete>[1]
  await client.complete(command.commandId, body, signal()); token = "new-token"; await client.complete(command.commandId, body, signal())
  assert.deepEqual(sent.map(r => r.authorization), ["Bearer old-token", "Bearer new-token"])
  assert.equal(sent[0]?.url, "https://runner.example/prefix/v1/remote-session-commands/cmd_test/complete")
  assert.equal(sent[0]?.method, "POST"); assert.equal(sent[0]?.redirect, "error"); assert.deepEqual(sent[0]?.body, body)
})

test("only HTTPS or HTTP loopback endpoints without embedded secrets are accepted", () => {
  const opts = { token: () => "token" }
  for (const baseUrl of ["http://runner.example", "file:///etc/config", "ftp://localhost", "https://user:secret@runner.example", "https://runner.example/?token=secret", "https://runner.example/#token"]) {
    assert.throws(() => createRemoteSessionTransport({ ...opts, baseUrl }), /Use HTTPS/)
  }
  for (const baseUrl of ["https://runner.example", "http://127.0.0.1:8790", "http://127.0.0.2:8790", "http://localhost:8790", "http://[::1]:8790"]) {
    assert.ok(createRemoteSessionTransport({ ...opts, baseUrl }))
  }
})

test("typed claim/pending/inventory reads match the existing small wire protocol", async () => {
  const paths: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const r = new globalThis.Request(input, init); paths.push(`${r.method} ${new URL(r.url).pathname}`)
    if (r.url.includes("commands/")) return json({ assignment: command })
    if (r.url.includes("requests/req_test")) return json({ assignment: request })
    if (r.url.endsWith("pending")) return json({ items: [{ kind: "remote_session_request", requestId: request.requestId }] })
    assert.deepEqual(await r.json(), inventory); return json({ ok: true, updatedAt: 123 })
  }
  const client = createRemoteSessionTransport({ baseUrl: "http://localhost:8790", token: () => "current", fetch: fetcher })
  assert.deepEqual(await client.claimCommand(command.commandId, signal()), command)
  assert.deepEqual(await client.claimRequest(request.requestId, signal()), request)
  assert.deepEqual(await client.pendingRequests(signal()), [{ kind: "remote_session_request", requestId: request.requestId }])
  await client.publishInventory(inventory, signal())
  assert.deepEqual(paths, ["POST /v1/remote-session-commands/cmd_test/claim", "POST /v1/remote-session-requests/req_test/claim",
    "GET /v1/remote-session-requests/pending", "PUT /v1/automation-runner/inventory"])
})

test("completeRequest and progress use their matching endpoints and validate acknowledgements", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const r = new globalThis.Request(input, init)
    assert.equal(r.method, "POST")
    if (r.url.endsWith("/session")) {
      assert.deepEqual(await r.json(), { status: "running", observedAt: 123 }); return json({ ok: true })
    }
    assert.deepEqual(await r.json(), { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } })
    return json({ request: { id: request.requestId, status: "done" } })
  }
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "token", fetch: fetcher })
  await client.report(command.commandId, { status: "running", observedAt: 123 }, signal())
  await client.completeRequest(request.requestId, { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } }, signal())
})

test("missing token and dot-segment IDs never issue an HTTP request", async () => {
  let calls = 0
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => null, fetch: async () => { calls++; return json({}) } })
  await assert.rejects(client.pendingRequests(signal()), /current runner token/)
  await assert.rejects(client.claimCommand("..", signal()), /dot segment/)
  assert.equal(calls, 0)
})

test("server HTTP errors expose only status, never provider body or bearer secret", async () => {
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "bearer-secret",
    fetch: async () => json({ leaked: "provider-secret" }, 401) })
  await assert.rejects(client.pendingRequests(signal()), error => {
    assert.ok(error instanceof RemoteSessionHttpError); assert.equal(error.status, 401)
    assert.equal(error.message.includes("secret"), false); return true
  })
})

test("redirect response is rejected even if an injected fetch ignores redirect:error", async () => {
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "token",
    fetch: async () => new Response("", { status: 302, headers: { location: "https://foreign.example" } }) })
  await assert.rejects(client.pendingRequests(signal()), /cannot follow redirects/)
})

test("bounded timeout covers an uncooperative fetch", async () => {
  let requestSignal: AbortSignal | null | undefined
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "token", timeoutMs: 5,
    fetch: async (_input, init) => { requestSignal = init?.signal; return new Promise<Response>(() => {}) } })
  await assert.rejects(client.pendingRequests(signal()), /timed out/)
  assert.equal(requestSignal?.aborted, true)
})

test("bounded timeout includes reading a stalled response body", async () => {
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "token", timeoutMs: 5,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) } })) })
  await assert.rejects(client.pendingRequests(signal()), /timed out/)
})

test("HTTP cancellation is preserved as AbortError", async () => {
  const controller = new AbortController(); controller.abort()
  const client = createRemoteSessionTransport({ baseUrl: "https://runner.example", token: () => "token", fetch: async () => json({}) })
  await assert.rejects(client.pendingRequests(controller.signal), { name: "AbortError" })
})

test("response limits reject both claimed length and chunked oversized JSON", async () => {
  const options = { baseUrl: "https://runner.example", token: () => "token" }
  const declared = createRemoteSessionTransport({ ...options, fetch: async () => new Response("{}", { headers: { "content-length": "524289" } }) })
  await assert.rejects(declared.pendingRequests(signal()), /size limit/)
  const streamed = createRemoteSessionTransport({ ...options, fetch: async () => new Response(" ".repeat(524289)) })
  await assert.rejects(streamed.pendingRequests(signal()), /size limit/)
})

test("mismatched claims and malformed acknowledgements fail closed", async () => {
  const options = { baseUrl: "https://runner.example", token: () => "token" }
  const claim = createRemoteSessionTransport({ ...options, fetch: async () => json({ assignment: { ...command, commandId: "foreign" } }) })
  await assert.rejects(claim.claimCommand(command.commandId, signal()), /does not match/)
  const complete = createRemoteSessionTransport({ ...options, fetch: async () => json({ command: { id: "foreign", status: "failed", sessionId: null, workspaceId: null } }) })
  await assert.rejects(complete.complete(command.commandId, { status: "failed", error: { code: "expired", message: "Expired" } }, signal()), /does not match/)
  const malformed = createRemoteSessionTransport({ ...options, fetch: async () => new Response("not json") })
  await assert.rejects(malformed.pendingRequests(signal()), /not valid JSON/)
})
