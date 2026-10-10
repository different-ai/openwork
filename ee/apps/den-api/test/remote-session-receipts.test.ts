import assert from "node:assert/strict"
import { test } from "node:test"
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, McpServer, PROTOCOL_VERSION_META_KEY, SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createScopedAgentMcpHttpHandlers } from "../src/mcp/agent-http.js"
import {
  parseRemoteSessionReceiptUri, readRemoteSessionReceipt, registerRemoteSessionReceiptResources,
  remoteSessionReceiptUri, withRemoteSessionReceiptUri, type RemoteSessionReceiptStores,
} from "../src/mcp/remote-session-resources.js"
import {
  createRemoteSessionReceiptSubscriptions, startRemoteSessionReceiptWatch,
  type ReceiptWatchClock,
} from "../src/mcp/remote-session-receipt-watch.js"
import type { RemoteSessionCommand } from "../src/remote-sessions/commands.js"
import type { RemoteSessionRequest } from "../src/remote-sessions/requests.js"

async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve() }
class Clock implements ReceiptWatchClock {
  time = 1_000
  timers = new Set<{ at: number; callback: () => void }>()
  now = () => this.time
  schedule = (callback: () => void, ms: number) => {
    const timer = { at: this.time + ms, callback }
    this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.time = next.at
      this.timers.delete(next)
      next.callback()
      await flush()
    }
    this.time = end
    await flush()
  }
}

function fixture() {
  const organizationId = createDenTypeId("organization")
  const createdByUserId = createDenTypeId("user")
  const commandId = createDenTypeId("remoteSessionCommand")
  const requestId = createDenTypeId("remoteSessionRequest")
  const command: RemoteSessionCommand = {
    id: commandId, organizationId, createdByUserId, ownerMemberId: createDenTypeId("member"),
    status: "pending", title: "Receipt example", prompt: "Not in the receipt", model: null, idempotencyKey: null,
    targetComputerId: "computer", targetWorkspaceId: null, expiresAt: 60_000,
    claimedByRunnerId: null, claimedAt: null, sessionId: null, workspaceId: null,
    resultSummary: null, error: null, session: null, createdAt: 1_000, updatedAt: 1_000,
  }
  const request: RemoteSessionRequest = {
    id: requestId, organizationId, createdByUserId, ownerMemberId: command.ownerMemberId,
    commandId, targetRunnerId: "runner", workspaceId: "workspace", sessionId: "session", engine: "v2",
    action: "stop", input: { messageId: null }, status: "pending", outcome: null, error: null,
    expiresAt: 60_000, claimedAt: null, completedAt: null, createdAt: 1_000, updatedAt: 1_000,
  }
  let reads = 0
  let failReads = false
  let hangReads = false
  const stores: RemoteSessionReceiptStores = {
    commandStore: { async get(input) {
      reads++
      if (failReads) throw new Error("database unavailable")
      if (hangReads) return new Promise(() => {})
      return input.commandId === commandId && input.organizationId === organizationId && input.createdByUserId === createdByUserId ? command : null
    } },
    requestStore: { async get(input) {
      reads++
      if (failReads) throw new Error("database unavailable")
      if (hangReads) return new Promise(() => {})
      return input.requestId === requestId && input.organizationId === organizationId && input.createdByUserId === createdByUserId ? request : null
    } },
  }
  const scope = { organizationId, createdByUserId }
  const uri = remoteSessionReceiptUri("commands", commandId)
  const requestUri = remoteSessionReceiptUri("requests", requestId)
  const read = (uri: string) => readRemoteSessionReceipt({ ...stores, ...scope, uri })
  return { scope, stores, command, request, uri, requestUri, read, get reads() { return reads },
    set failReads(value: boolean) { failReads = value }, set hangReads(value: boolean) { hangReads = value } }
}
function modern(method: string, params: object, id: string | number = 1, signal?: AbortSignal) {
  return new Request("https://example.test/mcp/agent", {
    method: "POST", signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      ...("uri" in params && typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "receipt-test-client", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {},
    } } }),
  })
}
function replica(data: ReturnType<typeof fixture>, clock = new Clock()) {
  const handlers = createScopedAgentMcpHttpHandlers()
  const subscriptions = createRemoteSessionReceiptSubscriptions(clock)
  let enabled = true
  let authorized = true
  let authCalls = 0
  let hangAuth = false
  const read = data.read
  const fetch = async (request: Request, userId: string = data.scope.createdByUserId) => {
    const server = new McpServer({ name: "receipt-test", version: "1" }, { capabilities: { resources: { subscribe: enabled, listChanged: true }, tools: { listChanged: true } } })
    if (enabled) registerRemoteSessionReceiptResources({ server, ...data.stores, ...data.scope, createdByUserId: userId })
    const scopeKey = `${data.scope.organizationId}\0${userId}`
    const streamKey = Symbol()
    return subscriptions.fetch({
      request, enabled, expiresAt: 100_000, scopeKey,
      read: (uri) => readRemoteSessionReceipt({ ...data.stores, ...data.scope, createdByUserId: userId, uri }),
      revalidate: async (hasReceipts) => {
        authCalls++
        if (hangAuth) return new Promise<boolean>(() => {})
        return authorized && (!hasReceipts || enabled)
      },
      notify: (uri) => handlers.notify.resourceUpdated(scopeKey, uri, streamKey),
      serve: (request) => handlers.fetch(scopeKey, request, server, streamKey),
    })
  }
  return { fetch, handlers, clock, read, get authCalls() { return authCalls },
    set enabled(value: boolean) { enabled = value }, set authorized(value: boolean) { authorized = value }, set hangAuth(value: boolean) { hangAuth = value } }
}
async function chunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Expected a stream frame within five seconds.")), 5_000)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await chunk(reader)
  assert.equal(next.done, false)
  const wire = new TextDecoder().decode(next.value)
  const data = wire.split("\n").find((line) => line.startsWith("data: "))
  assert.ok(data, wire)
  return JSON.parse(data.slice(6))
}
async function listen(instance: ReturnType<typeof replica>, uris: string[], id: string | number = 1, userId?: string, signal?: AbortSignal) {
  const response = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: uris, toolsListChanged: true } }, id, signal), userId)
  assert.equal(response.status, 200, await (response.headers.get("content-type")?.startsWith("text/event-stream") ? Promise.resolve("") : response.text()))
  assert.ok(response.body)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  const reader = response.body.getReader()
  const ack = await frame(reader)
  assert.equal(ack.method, "notifications/subscriptions/acknowledged")
  assert.equal(ack.params._meta[SUBSCRIPTION_ID_META_KEY], id)
  assert.deepEqual(ack.params.notifications, { toolsListChanged: true, resourceSubscriptions: uris })
  return reader
}

test("receipt URI parser accepts canonical ids only, and reads require both owner dimensions", async () => {
  const data = fixture()
  assert.ok(parseRemoteSessionReceiptUri(data.uri))
  for (const uri of ["openwork://remote-sessions/commands/*", `${data.uri}?x=1`, `${data.uri}#x`, data.uri.replace("commands", "requests"), data.uri.replace("openwork", "https"), "openwork://remote-sessions/commands/not_an_id"]) {
    assert.equal(parseRemoteSessionReceiptUri(uri), null)
    await assert.rejects(() => data.read(uri), /unavailable/)
  }
  for (const scope of [{ ...data.scope, createdByUserId: createDenTypeId("user") }, { ...data.scope, organizationId: createDenTypeId("organization") }]) {
    await assert.rejects(() => readRemoteSessionReceipt({ ...data.stores, ...scope, uri: data.uri }), /unavailable/)
    await assert.rejects(() => readRemoteSessionReceipt({ ...data.stores, ...scope, uri: data.requestUri }), /unavailable/)
  }
  const text = (await data.read(data.uri)).text
  assert.equal(text.includes("Not in the receipt"), false)
  assert.equal(text.includes(data.scope.createdByUserId), false)
})

test("stable receipt projection coalesces heartbeats but changes for waiting, results and errors", async () => {
  const data = fixture()
  data.command.session = { status: "running", waitingFor: null, engine: "v2", model: null, finalText: null, lastError: null, messageCount: 1, observedAt: 1_000 }
  const first = await data.read(data.uri)
  data.command.updatedAt++
  data.command.session.observedAt++
  assert.equal((await data.read(data.uri)).fingerprint, first.fingerprint)
  assert.notEqual((await data.read(data.uri)).text, first.text)
  data.command.session.status = "waiting"
  data.command.session.waitingFor = "question"
  assert.notEqual((await data.read(data.uri)).fingerprint, first.fingerprint)
  const pending = await data.read(data.requestUri)
  data.request.updatedAt++
  assert.equal((await data.read(data.requestUri)).fingerprint, pending.fingerprint)
  data.request.status = "done"
  data.request.outcome = { action: "stop", result: { stopped: true, reason: null } }
  assert.notEqual((await data.read(data.requestUri)).fingerprint, pending.fingerprint)
})

test("flag-gated URI decoration keeps original remote session tool result and never does I/O", () => {
  const data = fixture()
  const result = { content: [{ type: "text", text: "unchanged" }], structuredContent: { target: "desktop", commandId: data.command.id } }
  assert.equal(withRemoteSessionReceiptUri(result, false), result)
  assert.equal(withRemoteSessionReceiptUri(result, true).structuredContent.statusResourceUri, data.uri)
  assert.equal(withRemoteSessionReceiptUri({ structuredContent: { target: "desktop", commandId: data.command.id, requestId: data.request.id } }, true).structuredContent.statusResourceUri, data.requestUri)
  assert.equal(data.reads, 0)
})

test("modern SDK reads are private ttl zero and listen acknowledgment precedes URI-only invalidation", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  const response = await instance.fetch(modern("resources/read", { uri: data.uri }))
  const body = await response.json()
  assert.ok(body.result, JSON.stringify(body))
  assert.equal(body.result.cacheScope, "private")
  assert.equal(body.result.ttlMs, 0)
  assert.equal(body.result.resultType, "complete")
  assert.equal(JSON.parse(body.result.contents[0].text).state, "pending")
  const reader = await listen(instance, [data.uri], "watch-1")
  // A consumer reads immediately after the ack, including reconnects.
  assert.equal(JSON.parse((await instance.read(data.uri)).text).state, "pending")
  data.command.status = "claimed"
  await instance.clock.advance(2_000)
  const updated = await frame(reader)
  assert.equal(updated.method, "notifications/resources/updated")
  assert.deepEqual(updated.params, { uri: data.uri, _meta: { [SUBSCRIPTION_ID_META_KEY]: "watch-1" } })
  await reader.cancel()
  assert.equal(instance.clock.timers.size, 0)
})

test("SDK filters exact URIs and audiences, and same-member streams do not duplicate events", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  const one = await listen(instance, [data.uri], 1)
  const two = await listen(instance, [data.uri], 2)
  const request = await listen(instance, [data.requestUri], 3)
  const outsideUser = createDenTypeId("user")
  const outsider = await instance.fetch(modern("subscriptions/listen", { notifications: { toolsListChanged: true } }, 4), outsideUser)
  assert.ok(outsider.body)
  const outsideReader = outsider.body.getReader()
  await frame(outsideReader)
  data.command.status = "delivered"
  await instance.clock.advance(2_000)
  assert.equal((await frame(one)).params.uri, data.uri)
  assert.equal((await frame(two)).params.uri, data.uri)
  // Exercise the SDK's URI filters independently of our per-stream watchers.
  instance.handlers.notify.resourceUpdated(`${data.scope.organizationId}\0${data.scope.createdByUserId}`, data.uri)
  assert.equal((await frame(one)).params.uri, data.uri)
  assert.equal((await frame(two)).params.uri, data.uri)
  data.command.updatedAt++
  await instance.clock.advance(4_000)
  // Sentinel proves no heartbeat, duplicate or foreign update was queued.
  instance.handlers.notify.toolsChanged(`${data.scope.organizationId}\0${data.scope.createdByUserId}`)
  assert.equal((await frame(one)).method, "notifications/tools/list_changed")
  assert.equal((await frame(two)).method, "notifications/tools/list_changed")
  assert.equal((await frame(request)).method, "notifications/tools/list_changed")
  instance.handlers.notify.toolsChanged(`${data.scope.organizationId}\0${outsideUser}`)
  assert.equal((await frame(outsideReader)).method, "notifications/tools/list_changed", "outside audience gets only its own sentinel")
  await outsideReader.cancel()
  await Promise.all([one.cancel(), two.cancel(), request.cancel()])
  assert.equal(instance.clock.timers.size, 0)
})

test("malformed, unknown, foreign and feature-disabled subscriptions are denied before acknowledgment", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  for (const uri of ["openwork://remote-sessions/commands/*", remoteSessionReceiptUri("commands", createDenTypeId("remoteSessionCommand")), data.uri + "?x=1"]) {
    const response = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [uri] } }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, -32602)
    assert.equal(response.headers.get("content-type"), "application/json")
  }
  const foreign = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [data.uri, data.requestUri] } }), createDenTypeId("user"))
  assert.equal(foreign.status, 400)
  instance.enabled = false
  const disabled = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [data.uri] } }))
  assert.equal(disabled.status, 400)
  assert.equal(instance.clock.timers.size, 0)
})

test("URI and member stream limits are bounded and cancellation frees capacity on Node", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  const tooMany = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: Array.from({ length: 11 }, () => data.uri) } }))
  assert.equal(tooMany.status, 400)
  const readers = await Promise.all([1, 2, 3, 4].map((id) => listen(instance, [data.uri], id)))
  const full = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [data.uri] } }, 5))
  assert.equal(full.status, 429)
  await readers[0].cancel()
  const next = await listen(instance, [data.uri], 6)
  await Promise.all([...readers.slice(1), next].map((reader) => reader.cancel()))
  // Test Response.body.cancel() without first acquiring a reader as well.
  const response = await instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [data.uri] } }, 7))
  assert.ok(response.body)
  await response.body.cancel()
  assert.equal(instance.clock.timers.size, 0)
})

test("independent replicas observe shared receipt writes and reconnect reads current state without replay", async (t) => {
  const data = fixture()
  const a = replica(data)
  const b = replica(data)
  t.after(async () => { await a.handlers.close(); await b.handlers.close() })
  const reader = await listen(a, [data.requestUri])
  data.request.status = "claimed" // A different replica writes the shared database; no event bus publish.
  await a.clock.advance(2_000)
  assert.equal((await frame(reader)).params.uri, data.requestUri)
  await reader.cancel()
  const reads = data.reads
  data.request.status = "done"
  data.request.outcome = { action: "stop", result: { stopped: true, reason: null } }
  await a.clock.advance(10_000)
  assert.equal(data.reads, reads, "no watchers or database polls while disconnected")
  const reconnected = await listen(b, [data.requestUri], 2)
  assert.equal(JSON.parse((await b.read(data.requestUri)).text).state, "done")
  b.handlers.notify.toolsChanged(`${data.scope.organizationId}\0${data.scope.createdByUserId}`)
  assert.equal((await frame(reconnected)).method, "notifications/tools/list_changed", "no replayed update before sentinel")
  await reconnected.cancel()
})

for (const reason of ["authorization", "feature", "database", "hung-auth", "hung-database", "disconnect"]) {
  test(`subscription fails closed and releases watcher on ${reason}`, async (t) => {
    const data = fixture()
    const instance = replica(data)
    t.after(() => instance.handlers.close())
    const abort = new AbortController()
    const reader = await listen(instance, [data.uri], 1, undefined, abort.signal)
    const pending = chunk(reader)
    // Install the rejection handler before advancing timers.
    const ended = assert.rejects(pending, /authorized|aborted/)
    if (reason === "authorization") instance.authorized = false
    if (reason === "feature") instance.enabled = false
    if (reason === "database") data.failReads = true
    if (reason === "hung-database") data.hangReads = true
    if (reason === "hung-auth") instance.hangAuth = true
    if (reason === "disconnect") abort.abort()
    await instance.clock.advance(reason === "hung-auth" ? 20_000 : 15_000)
    await ended
    assert.equal(instance.clock.timers.size, 0)
    const reads = data.reads
    await instance.clock.advance(20_000)
    assert.equal(data.reads, reads)
  })
}

test("a hung pre-ack authorization check times out, performs no receipt read and frees capacity", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  instance.hangAuth = true
  const pending = instance.fetch(modern("subscriptions/listen", { notifications: { resourceSubscriptions: [data.uri] } }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(instance.clock.timers.size > 0, "the authorization deadline is armed")
  await instance.clock.advance(5_000)
  const response = await pending
  assert.equal(response.status, 503)
  assert.equal(data.reads, 0)
  assert.equal(instance.clock.timers.size, 0)
  instance.hangAuth = false
  const readers = await Promise.all([1, 2, 3, 4].map((id) => listen(instance, [data.uri], id)))
  await Promise.all(readers.map((reader) => reader.cancel()))
})

test("killing receipt events leaves ordinary catalog subscriptions and store reads available", async (t) => {
  const data = fixture()
  const instance = replica(data)
  t.after(() => instance.handlers.close())
  const receiptReader = await listen(instance, [data.uri])
  const catalog = await instance.fetch(modern("subscriptions/listen", { notifications: { toolsListChanged: true } }, 2))
  assert.ok(catalog.body)
  const catalogReader = catalog.body.getReader()
  assert.deepEqual((await frame(catalogReader)).params.notifications, { toolsListChanged: true })
  const killed = assert.rejects(chunk(receiptReader), /authorized/)
  instance.enabled = false
  await instance.clock.advance(15_000)
  await killed
  instance.handlers.notify.toolsChanged(`${data.scope.organizationId}\0${data.scope.createdByUserId}`)
  assert.equal((await frame(catalogReader)).method, "notifications/tools/list_changed")
  assert.equal(JSON.parse((await instance.read(data.uri)).text).state, "pending")
  await catalogReader.cancel()
  assert.equal(instance.clock.timers.size, 0)
})

test("SDK shutdown stops polling while preserving its graceful subscription result", async () => {
  const data = fixture()
  const instance = replica(data)
  const reader = await listen(instance, [data.uri], "shutdown")
  data.hangReads = true
  await instance.clock.advance(2_000)
  const reads = data.reads
  await instance.handlers.close()
  await flush()
  assert.equal(instance.clock.timers.size, 0)
  await instance.clock.advance(10_000)
  assert.equal(data.reads, reads, "a hung in-flight poll is cancelled and not restarted")
  const result = await frame(reader)
  assert.equal(result.id, "shutdown")
  assert.equal(result.result.resultType, "complete")
  assert.equal(result.result._meta[SUBSCRIPTION_ID_META_KEY], "shutdown")
  assert.equal((await chunk(reader)).done, true)
})

test("watch expires at the exact token deadline even when the authorization service hangs", async () => {
  const clock = new Clock()
  const controller = new AbortController()
  startRemoteSessionReceiptWatch({ baseline: new Map(), read: async () => ({ fingerprint: "" }), revalidate: () => new Promise(() => {}), notify() {}, controller, expiresAt: 2_500, clock })
  await clock.advance(1_499)
  assert.equal(controller.signal.aborted, false)
  await clock.advance(1)
  assert.equal(controller.signal.aborted, true)
  assert.equal(clock.timers.size, 0)
})
