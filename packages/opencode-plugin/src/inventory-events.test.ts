import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { inventorySessionKey, SseParser, subscribeInventory, subscribeSharedInventory } from "./inventory-events.ts"

const session = { apiBaseUrl: "https://den.example", token: "secret-session", orgId: "org_one" }

test("the globally readable inventory hub exposes no credentials, callbacks, registry or mutable state", async () => {
  const controller = new AbortController()
  const resolveSession = async () => session
  const pending = subscribeSharedInventory({
    identity: session,
    signal: controller.signal,
    session: resolveSession,
    changed: () => {},
    fetch: async () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
  })
  try {
    await delay(5)
    const hub = globalThis.__openworkInventorySubscriptions
    assert.ok(hub)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__openworkInventorySubscriptions")
    assert.equal(descriptor?.writable, false)
    assert.equal(descriptor?.configurable, false)
    assert.equal(descriptor?.enumerable, false)
    assert.deepEqual(Reflect.ownKeys(hub), ["join"])
    assert.equal(Reflect.get(hub, "get"), undefined, "the old registry name is not a Map")
    assert.equal(Reflect.get(hub, "session"), undefined)
    assert.equal(Reflect.get(hub, inventorySessionKey(session)), undefined, "a known identity hash cannot look up another listener")
    assert.equal(Reflect.set(hub, "join", () => assert.fail("replacement must never run")), false)
    assert.equal(Reflect.set(globalThis, "__openworkInventorySubscriptions", new Map()), false)
    assert.equal(Reflect.deleteProperty(globalThis, "__openworkInventorySubscriptions"), false)
    const seen = new Set<unknown>()
    const inspect = (value: unknown) => {
      assert.notEqual(value, resolveSession)
      assert.notEqual(value, session)
      if (typeof value === "string") assert.ok(!value.includes(session.token))
      if ((!value || typeof value !== "object") && typeof value !== "function") return
      if (seen.has(value)) return
      seen.add(value)
      assert.ok(!(value instanceof Map), "no reachable listener registry")
      assert.ok(Object.isFrozen(value), "all globally reachable hub state is immutable")
      for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
        assert.equal(property.get, undefined, "no getter may expose private state")
        const nested: unknown = property.value
        inspect(nested)
      }
    }
    inspect(hub)
    assert.ok(!JSON.stringify(hub).includes(session.token))
  } finally {
    controller.abort()
    await pending
  }
})

test("a caller knowing only a session hash cannot join its registry entry or obtain its Den bearer", async () => {
  const owner = new AbortController()
  const caller = new AbortController()
  let ownerCalls = 0
  let callerCalls = 0
  const ownerPending = subscribeSharedInventory({
    identity: session,
    signal: owner.signal,
    session: async () => session,
    changed: () => {},
    fetch: async () => {
      ownerCalls++
      return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const ownIdentity = { ...session, token: inventorySessionKey(session) }
  const callerPending = globalThis.__openworkInventorySubscriptions?.join({
    identity: ownIdentity,
    signal: caller.signal,
    session: async () => ownIdentity,
    changed: () => {},
    fetch: async (_url, init) => {
      callerCalls++
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${ownIdentity.token}`)
      assert.notEqual(new Headers(init?.headers).get("authorization"), `Bearer ${session.token}`)
      return new Response(null, { status: 404 })
    },
  })
  try {
    assert.ok(callerPending)
    await delay(5)
    assert.equal(ownerCalls, 1)
    assert.equal(callerCalls, 1, "a hash is a different identity, not a lookup capability")
    caller.abort()
    await callerPending
    assert.equal(owner.signal.aborted, false, "caller release cannot abort the owner's subscription")
    assert.equal(ownerCalls, 1)
  } finally {
    caller.abort()
    owner.abort()
    await Promise.all([ownerPending, callerPending])
  }
})

test("five separate ESM graphs share one private stream and joining fetchers cannot intercept its credentials", async () => {
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const changes = Array.from({ length: 5 }, () => 0)
  let fetches = 0
  let injectedFetches = 0
  let cancellations = 0
  const pending: Promise<void>[] = []
  try {
    for (const [index, controller] of controllers.entries()) {
      const graph: typeof import("./inventory-events.ts") = await import(new URL(`./inventory-events.ts?private-hub-graph=${index}`, import.meta.url).href)
      pending.push(graph.subscribeSharedInventory({
        identity: session,
        signal: controller.signal,
        retryMs: 1,
        session: async () => session,
        changed: () => { changes[index] = (changes[index] ?? 0) + 1 },
        fetch: index === 0 ? async (_url, init) => {
          fetches++
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${session.token}`)
          return new Response(new ReadableStream<Uint8Array>({
            start(stream) { streams.push(stream) },
            cancel() { cancellations++ },
          }), { headers: { "content-type": "text/event-stream" } })
        } : async () => {
          injectedFetches++
          throw new Error("a joining fetcher must never take ownership of an existing stream")
        },
      }))
    }
    await delay(5)
    assert.equal(fetches, 1)
    assert.equal(injectedFetches, 0)
    assert.deepEqual(changes, [1, 1, 1, 1, 1])
    controllers[0]?.abort()
    await pending[0]
    assert.equal(cancellations, 0, "the first Location unloading leaves the shared stream open")
    streams[0]?.close()
    for (let i = 0; i < 100 && fetches < 2; i++) await delay(2)
    assert.equal(fetches, 2)
    assert.equal(injectedFetches, 0, "reconnect cannot pass a remaining listener's session to its injected fetcher")
    assert.equal(changes[0], 1, "the unloaded Location is not retained as a listener")
    assert.ok(changes.slice(1).every(count => count === 2))
    for (const controller of controllers.slice(1, -1)) controller.abort()
    await delay(5)
    assert.equal(cancellations, 0)
    controllers.at(-1)?.abort()
    await Promise.all(pending)
    assert.equal(cancellations, 1, "the last Location unloading cancels the active stream")
  } finally {
    for (const controller of controllers) controller.abort()
    await Promise.all(pending)
  }
})

test("SSE frames tolerate split CRLF, comments, multiline data, unknown fields and UTF-8 chunk boundaries", () => {
  const events: { event: string; data: string }[] = []
  const parser = new SseParser(event => events.push(event))
  const decoder = new TextDecoder()
  const bytes = new TextEncoder().encode(": heartbeat\r\nevent: inventory.changed\r\ndata: {\"revision\":\"é\"}\r\ndata: second\r\nignored: value\r\n\r\n")
  for (const byte of bytes) parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }))
  assert.deepEqual(events, [{ event: "inventory.changed", data: '{"revision":"é"}\nsecond' }])
  assert.throws(() => parser.push("x".repeat(1024 * 1024 + 1)), /too large/)
})

test("subscription reconciles each connection and event, re-resolves session, and cancels the reader", async () => {
  const controller = new AbortController()
  let calls = 0
  let resolved = 0
  let changes = 0
  let cancelled = false
  const headers: Headers[] = []
  const promise = subscribeInventory({
    signal: controller.signal, retryMs: 1,
    session: async () => ({ ...session, token: `token-${++resolved}` }),
    changed: () => { changes++ },
    fetch: async (_url, init) => {
      calls++
      headers.push(new Headers(init?.headers))
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("event: inventory.changed\ndata: {\"revision\":\"1\"}\n\n"))
          if (calls === 1) stream.close()
        },
        cancel() { cancelled = true },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  for (let i = 0; i < 100 && calls < 2; i++) await delay(2)
  assert.equal(calls, 2)
  assert.equal(changes, 4)
  assert.equal(headers[0]?.get("authorization"), "Bearer token-1")
  assert.equal(headers[1]?.get("authorization"), "Bearer token-2")
  assert.equal(headers[1]?.get("x-openwork-org-id"), session.orgId)
  controller.abort()
  await promise
  assert.equal(cancelled, true)
})

test("a silent stream times out, reconnects, and stops retrying after cancellation", async () => {
  const controller = new AbortController()
  let connections = 0
  const promise = subscribeInventory({
    signal: controller.signal, heartbeatMs: 5, retryMs: 1,
    session: async () => session,
    changed: () => { connections++ },
    fetch: async () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
  })
  for (let i = 0; i < 100 && connections < 2; i++) await delay(2)
  assert.ok(connections >= 2)
  controller.abort()
  await promise
  const stoppedAt = connections
  await delay(10)
  assert.equal(connections, stoppedAt)
})

test("stream 401 reports an invalid session without a generic changed event or retry", async () => {
  let revoked = 0
  let calls = 0
  await subscribeInventory({
    signal: new AbortController().signal,
    session: async () => session,
    changed: () => assert.fail("auth failure must not look like an inventory change"),
    unauthorized: () => { revoked++ },
    fetch: async () => { calls++; return Response.json({ error: "denied" }, { status: 401 }) },
  })
  assert.equal(calls, 1)
  assert.equal(revoked, 1)
})

for (const status of [403, 404]) {
  test(`stream ${status} organization denial clears authority and recovers with the same session on a bounded retry`, async () => {
    const controller = new AbortController()
    let revoked = 0
    let calls = 0
    let changes = 0
    let granted = false
    const promise = subscribeInventory({
      signal: controller.signal, retryMs: 20,
      session: async () => session,
      changed: () => { changes++ },
      unauthorized: () => assert.fail("organization membership loss must not invalidate the session"),
      revoked: () => { revoked++ },
      fetch: async (_url, init) => {
        calls++
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${session.token}`)
        if (!granted) return Response.json({ error: "organization_not_found" }, { status })
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
      },
    })
    await delay(5)
    assert.equal(calls, 1)
    assert.equal(revoked, 1)
    assert.equal(changes, 0)
    granted = true
    for (let i = 0; i < 100 && !changes; i++) await delay(2)
    assert.equal(calls, 2)
    assert.equal(changes, 1, "successful regrant reconciles even without an SSE event")
    controller.abort()
    await promise
    await delay(25)
    assert.equal(calls, 2, "unload stops authorization probes")
  })
}

test("a killed shared session remains terminal when another Location joins", async () => {
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  let calls = 0
  const options = {
    identity: session,
    session: async () => session,
    changed: () => assert.fail("disabled stream must not publish"),
    unauthorized: () => assert.fail("kill must retain authority"),
    revoked: () => assert.fail("kill must retain authority"),
    fetch: async () => { calls++; return Response.json({ error: "feature_disabled", feature: "retiredFeature" }, { status: 404 }) },
  }
  const first = subscribeSharedInventory({ ...options, signal: controllers[0]!.signal })
  await delay(5)
  const rest = controllers.slice(1).map(controller => subscribeSharedInventory({ ...options, signal: controller.signal }))
  await delay(5)
  assert.equal(calls, 1)
  for (const controller of controllers) controller.abort()
  await Promise.all([first, ...rest])
})

for (const body of [
  JSON.stringify({ error: "feature_disabled", feature: "retiredFeature" }),
  JSON.stringify({ code: "feature_disabled" }),
  JSON.stringify({ error: "not_found" }),
  JSON.stringify({ code: "organization_not_found" }),
  JSON.stringify({ nested: { error: "organization_not_found" } }),
  "Not Found",
  "",
  "x".repeat(16 * 1024 + 1),
]) {
  test(`feature-disabled or unsupported 404 stays terminal without auth clearing (${body.slice(0, 70)})`, async () => {
    let calls = 0
    await subscribeInventory({
      signal: new AbortController().signal, retryMs: 1,
      session: async () => session,
      changed: () => assert.fail("disabled stream must not publish"),
      unauthorized: () => assert.fail("unsupported or killed stream must not invalidate the session"),
      revoked: () => assert.fail("only the explicit Den organization error revokes membership"),
      fetch: async () => { calls++; return new Response(body, { status: 404 }) },
    })
    assert.equal(calls, 1)
  })
}

test("a Location joining a revoked shared subscription is cleared without bypassing retry backoff", async () => {
  const controllers = [new AbortController(), new AbortController()]
  let calls = 0
  let revoked = 0
  let changes = 0
  let granted = false
  const options = {
    identity: session,
    retryMs: 40,
    session: async () => session,
    changed: () => { changes++ },
    revoked: () => { revoked++ },
    fetch: async () => {
      calls++
      return granted
        ? new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error: "organization_not_found" }, { status: 404 })
    },
  }
  const first = subscribeSharedInventory({ ...options, signal: controllers[0]!.signal })
  await delay(5)
  assert.equal(revoked, 1)
  const second = subscribeSharedInventory({ ...options, signal: controllers[1]!.signal })
  await delay(5)
  assert.equal(calls, 1)
  assert.equal(revoked, 2, "new Location receives denial, not a stale inventory changed event")
  assert.equal(changes, 0)
  granted = true
  for (let i = 0; i < 100 && changes < 2; i++) await delay(2)
  assert.equal(calls, 2)
  assert.equal(changes, 2)
  for (const controller of controllers) controller.abort()
  await Promise.all([first, second])
})
