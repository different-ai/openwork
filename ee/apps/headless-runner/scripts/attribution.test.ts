import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { z } from "zod"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { attributionHeaders, validAttributionHeader } from "../src/attribution.js"
import { loadConfig } from "../src/config.js"
import { anthropicModel, openAIModel } from "../src/model.js"
import { createRuntime } from "../src/runtime.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Store } from "../src/store.js"
import { Runner } from "../src/runner.js"

const identity = { organizationId: "org_test", memberId: "mem_first", userId: "usr_first", email: "first@example.test" }
const env = { HEADLESS_API_TOKEN: "a".repeat(32), HEADLESS_MODEL_PROTOCOL: "openai", HEADLESS_MODEL_BASE_URL: "http://127.0.0.1", HEADLESS_MODEL: "default-alias", HEADLESS_MODEL_API_KEY: "service-key" }

test("configuration is explicit, off by default, and rejects injection and reserved headers", () => {
  assert.equal(loadConfig(env).model.userHeader, undefined)
  assert.equal(loadConfig({ ...env, HEADLESS_MODEL_USER_HEADER: "" }).model.userHeader, undefined)
  assert.deepEqual(loadConfig({ ...env, HEADLESS_MODEL_USER_HEADER: "X-User-Id" }).model.userHeader, { name: "X-User-Id", format: "member_id" })
  for (const name of ["X-User-Id\r\nx-key", "bad name", "Authorization", "AUTHORIZATION", "x-api-key", "x-auth-token", "Cookie", "Host", "Content-Length", "Transfer-Encoding", "Connection", "anthropic-version", "OpenAI-Organization", "x-forwarded-for", "x-openwork-headless-owner"]) {
    assert.equal(validAttributionHeader(name), false, name)
    assert.throws(() => loadConfig({ ...env, HEADLESS_MODEL_USER_HEADER: name }), /Invalid headless-runner configuration/)
  }
  assert.throws(() => loadConfig({ ...env, HEADLESS_MODEL_USER_HEADER_FORMAT: "unknown" }), /HEADLESS_MODEL_USER_HEADER_FORMAT/)
  for (const [format, value] of [["member_id", identity.memberId], ["user_id", identity.userId], ["owner", "org_test:mem_first"], ["email", identity.email]]) {
    const policy = { name: "x-portkey-user-id", format: z.enum(["member_id", "user_id", "owner", "email"]).parse(format) }
    assert.deepEqual(attributionHeaders(policy, identity), { "x-portkey-user-id": value })
    assert.throws(() => attributionHeaders(policy, { ...identity, memberId: "mem_test\r\nx-key: injected" }), /Invalid model attribution identity/)
  }
  assert.deepEqual(attributionHeaders({ name: "x-user-id", format: "email" }, { ...identity, email: undefined }), {})
})

test("background tasks and reports inherit the originating identity; a resumed turn uses fresh credentials", async () => {
  const store = new Store(nodeSqlite(":memory:"))
  const seen: Array<string | null> = []
  let rejectNext = false
  const model = openAIModel({ baseUrl: "https://gateway.example.test", maxOutputTokens: 1024, userHeader: { name: "x-user-id", format: "member_id" }, fetch: async (_url, init) => {
    seen.push(new Headers(init?.headers).get("x-user-id"))
    if (rejectNext) { rejectNext = false; return new Response("refused", { status: 401 }) }
    return Response.json({ choices: [{ message: seen.length === 1 ? { content: "Delegating", tool_calls: [{ id: "task", type: "function", function: { name: "start_task", arguments: JSON.stringify({ title: "Check details", brief: "Read the details" }) } }] } : { content: "Done" } }] })
  } })
  const runner = new Runner({ store, model, defaultModel: "alias", defaultModelApiKey: "key", limits: { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Infinity, credentialRefreshMs: Infinity, contextCharBudget: 100_000 } })
  const session = store.createSession({ tasks: true })
  runner.send({ sessionId: session.id, messageId: "origin", prompt: "Check my details", credentials: { modelAttribution: identity } })
  await runner.idle()
  assert.ok(store.getTurn(session.id, "origin.t1"), "background lane actually ran")
  assert.equal(store.getTurn(session.id, "origin.t1.r")?.status, "completed", "task report actually ran")
  assert.ok(seen.length >= 4)
  assert.ok(seen.every((value) => value === identity.memberId))
  rejectNext = true
  runner.send({ sessionId: session.id, messageId: "retry", prompt: "Check again", credentials: { modelAttribution: identity } })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "retry")?.status, "failed")
  const before = seen.length
  runner.send({ sessionId: session.id, messageId: "retry", prompt: "resume", credentials: {} })
  await runner.idle()
  assert.ok(seen.length > before)
  assert.ok(seen.slice(before).every((value) => value === null), "a resume without attribution cannot retain old identity")
})

for (const protocol of ["openai", "anthropic"] as const) {
  test(`${protocol}: protocol → API → runtime → real inference HTTP isolates members, model aliases, title calls and disabled turns`, async () => {
    const captured: Array<{ headers: import("node:http").IncomingHttpHeaders; model: string; stream?: boolean; body: string }> = []
    let catalogReceived = 0
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        assert.equal(req.headers["x-user-id"], undefined, "model catalog requests carry no user identity")
        catalogReceived++
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ data: [{ id: "selected-provider-alias" }] }))
        return
      }
      let body = ""
      for await (const chunk of req) body += chunk
      const parsed = z.object({ model: z.string(), stream: z.boolean().optional() }).parse(JSON.parse(body))
      captured.push({ headers: req.headers, ...parsed, body })
      if (parsed.stream) {
        res.setHeader("content-type", "text/event-stream")
        const events = protocol === "openai"
          ? [{ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] }]
          : [{ type: "content_block_delta", delta: { type: "text_delta", text: "Done" } }, { type: "message_stop" }]
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
      } else {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(protocol === "openai" ? { choices: [{ message: { content: "A short title" } }] } : { content: [{ type: "text", text: "A short title" }] }))
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      for (const configured of [true, false]) {
        const store = new Store(nodeSqlite(":memory:"))
        const config = loadConfig({ ...env, HEADLESS_MODEL_PROTOCOL: protocol, HEADLESS_MODEL_BASE_URL: baseUrl, ...(configured ? { HEADLESS_MODEL_USER_HEADER: "X-User-Id" } : {}) })
        const runtime = await createRuntime(config, store)
        const client = createHeadlessRunnerClient({
          config: { url: "http://runner", token: env.HEADLESS_API_TOKEN },
          fetch: (input, init) => runtime.app.fetch(new Request(input, init)),
          maxTokenTtlMs: 60_000,
          mintToken: async (actor) => ({ token: "private-mcp-token", ...(actor.userId === "disabled" ? {} : { modelAttribution: { ...identity, userId: actor.userId, memberId: `mem_${actor.userId}` } }) }),
        })
        assert.ok(await client.listModels())
        const sessions = ["first", "second", "disabled"].map((user) => ({ user, session: store.createSession({ autoTitle: true, owner: "untrusted-owner-not-used" }).id }))
        const start = captured.length
        await Promise.all(sessions.map(async ({ user, session }) => {
          const sent = await client.sendTurn({ organizationId: identity.organizationId, userId: user }, { sessionId: session, messageId: "message", prompt: "Help me plan today", model: "selected-provider-alias" })
          assert.ok(sent.ok)
        }))
        await runtime.runner.idle()
        // Naming runs outside idle(); await its observable completion without relying on a fixed delay.
        for (let attempt = 0; sessions.some(({ session }) => !store.getSession(session)?.title) && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
        for (const { session } of sessions) {
          assert.equal(store.getTurn(session, "message")?.status, "completed")
          assert.equal(store.getSession(session)?.title, "A short title")
          const snapshot = await client.readSession(session)
          assert.equal(JSON.stringify(snapshot).includes("modelAttribution"), false)
          assert.equal(JSON.stringify(snapshot).includes("private-mcp-token"), false)
        }
        const requests = captured.slice(start)
        assert.equal(requests.length, 6, "three streamed turns and three non-streamed titles reached the server")
        for (const streamed of [true, false]) {
          const calls = requests.filter((request) => Boolean(request.stream) === streamed)
          assert.deepEqual(calls.map((call) => call.headers["x-user-id"] ?? "absent").sort(), configured ? ["absent", "mem_first", "mem_second"] : ["absent", "absent", "absent"])
          for (const call of calls) {
            assert.equal(call.model, streamed ? "selected-provider-alias" : "default-alias")
            assert.equal(call.headers[protocol === "openai" ? "authorization" : "x-api-key"], protocol === "openai" ? "Bearer service-key" : "service-key")
            assert.equal(call.headers["content-type"], "application/json")
            assert.equal(call.body.includes("mem_first"), false, "identity is not put in model context")
            assert.equal(call.body.includes("private-mcp-token"), false)
          }
        }
        const bad = await runtime.app.request(`/v1/sessions/${sessions[0].session}/turns`, { method: "POST", headers: { authorization: `Bearer ${env.HEADLESS_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ messageId: "bad", prompt: "hello", credentials: { modelAttribution: { ...identity, memberId: "bad\r\nvalue" } } }) })
        assert.equal(bad.status, 400)
        const unauthorized = await runtime.app.request(`/v1/sessions/${sessions[0].session}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: "bad", prompt: "hello", credentials: { modelAttribution: identity } }) })
        assert.equal(unauthorized.status, 401)
      }
      assert.equal(catalogReceived, 2, "both configured and disabled runtimes exercised the live catalog")
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test(`${protocol}: an HTTP redirect cannot disclose identity or credentials to another server`, async () => {
    let disclosed = 0
    const destination = createServer((_request, response) => { disclosed++; response.end("unexpected") })
    destination.listen(0, "127.0.0.1")
    await once(destination, "listening")
    const target = destination.address()
    assert.ok(target && typeof target === "object")
    const gateway = createServer((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${target.port}/capture` }); response.end() })
    gateway.listen(0, "127.0.0.1")
    await once(gateway, "listening")
    const source = gateway.address()
    assert.ok(source && typeof source === "object")
    try {
      const model = (protocol === "openai" ? openAIModel : anthropicModel)({ baseUrl: `http://127.0.0.1:${source.port}`, maxOutputTokens: 1024, userHeader: { name: "x-user-id", format: "member_id" }, sleep: async () => {} })
      await assert.rejects(model.complete({ apiKey: "private-provider-key", attribution: identity, model: "alias", system: "Helpful", messages: [{ role: "user", text: "hello" }], tools: [], signal: new AbortController().signal }))
      assert.equal(disclosed, 0, "the redirect destination received no HTTP request")
    } finally {
      for (const server of [gateway, destination]) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })

  test(`${protocol}: retries keep attribution; redirects are refused and unsafe direct configuration cannot override credentials`, async () => {
    const calls: RequestInit[] = []
    const model = (protocol === "openai" ? openAIModel : anthropicModel)({ baseUrl: "https://gateway.example.test", maxOutputTokens: 1024, userHeader: { name: "x-member-id", format: "member_id" }, sleep: async () => {}, fetch: async (_input, init) => {
      calls.push(init ?? {})
      if (calls.length === 1) return new Response("busy", { status: 429 })
      return Response.json(protocol === "openai" ? { choices: [{ message: { content: "Done" } }] } : { content: [{ type: "text", text: "Done" }] })
    } })
    const request = { apiKey: "provider-key", attribution: identity, model: "alias", system: "Helpful", messages: [{ role: "user" as const, text: "hello" }], tools: [], signal: new AbortController().signal }
    await model.complete(request)
    assert.equal(calls.length, 2)
    for (const call of calls) {
      const headers = new Headers(call.headers)
      assert.equal(headers.get("x-member-id"), "mem_first")
      assert.equal(headers.get(protocol === "openai" ? "authorization" : "x-api-key"), protocol === "openai" ? "Bearer provider-key" : "provider-key")
      if (protocol === "anthropic") assert.equal(headers.get("anthropic-version"), "2023-06-01")
      assert.equal(call.redirect, "error")
    }
    const invalid = (protocol === "openai" ? openAIModel : anthropicModel)({ baseUrl: "https://gateway.example.test", maxOutputTokens: 1024, userHeader: { name: "Authorization", format: "member_id" }, fetch: async () => { assert.fail("unsafe policy must fail before network") } })
    await assert.rejects(invalid.complete(request), /Invalid model attribution header name/)
  })
}
