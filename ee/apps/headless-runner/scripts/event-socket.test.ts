/**
 * Live events over WebSockets: the runner's route publishes the same JSON as the SSE stream to a host's sockets, the
 * Node host answers an upgrade without upgrading, and the protocol client's `openEventsSocket` sends its token and
 * owner in headers, reads events, and gives null (fall back to SSE) whenever there is no socket. celld's own sockets
 * are exercised end to end in scripts/owner-cells-e2e.ts.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { Duplex } from "node:stream"
import { test } from "node:test"
import { z } from "zod"
import { serve } from "@hono/node-server"
import { createHeadlessRunnerClient, type HeadlessRunnerConfig, type RunnerLiveEvent } from "@openwork-ee/headless-protocol"
import { createApp } from "../src/app.js"
import { SessionEvents, type EventSockets } from "../src/events.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const token = `test_${"t".repeat(40)}`
const auth = { authorization: `Bearer ${token}` }
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 100_000 }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A model that streams text and starts a file tool call, then answers once the tool's result is in. */
const model: ModelClient = {
  async complete(request) {
    if (request.messages.at(-1)?.role === "tool") {
      request.onText?.("Saved")
      request.onText?.(" it.")
      return { text: "Saved it.", toolCalls: [], usage }
    }
    request.onText?.("Let me ")
    request.onText?.("write that.")
    request.onTool?.("write_file")
    return { text: "Let me write that.", toolCalls: [{ id: "call_1", name: "write_file", input: { path: "note.md", content: "hi" } }], usage }
  },
}

function world() {
  const store = new Store(nodeSqlite(":memory:"))
  const events = new SessionEvents()
  store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events })
  const app = createApp({ store, runner, apiToken: token, events })
  return { store, events, runner, app, session: store.createSession({ owner: "test" }).id }
}

/** Reads an SSE response's `data:` payloads until `stop` is called. */
function sseData(response: Response, into: string[]) {
  assert.ok(response.body)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  return { done: read(reader, into), stop: () => reader.cancel() }
}
async function read(reader: ReadableStreamDefaultReader<string>, into: string[]) {
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += value
      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf("\n\n")
        if (/^event: ready/m.test(block) || block.startsWith(":")) continue
        into.push(block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
      }
    }
  } catch {
    // Aborted.
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}
/** Upgraded sockets leave the server's own connection tracking: destroy them too. */
const upgraded = new Set<Duplex>()
const closeServer = (server: Server) => {
  server.closeAllConnections()
  for (const socket of upgraded) socket.destroy()
  upgraded.clear()
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

function client(config: HeadlessRunnerConfig) {
  return createHeadlessRunnerClient({ config, fetch, mintToken: async () => ({ token: "unused" }), maxTokenTtlMs: 60_000 })
}

/** The server half of a WebSocket handshake and text frames, enough to stand in for a runner that upgrades. */
function acceptUpgrade(request: IncomingMessage, socket: Duplex) {
  upgraded.add(socket)
  const accept = createHash("sha1").update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"))
  const received: string[] = []
  let closed = false
  socket.on("error", () => undefined)
  socket.on("data", (chunk: Buffer) => {
    for (let offset = 0; offset + 6 <= chunk.length; ) {
      const opcode = (chunk[offset] ?? 0) & 0x0f
      const length = (chunk[offset + 1] ?? 0) & 0x7f
      const mask = chunk.subarray(offset + 2, offset + 6)
      const payload = Buffer.from(chunk.subarray(offset + 6, offset + 6 + length).map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
      if (opcode === 1) received.push(payload.toString())
      if (opcode === 8 && !closed) {
        closed = true
        socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]))
      }
      offset += 6 + length
    }
  })
  return {
    received,
    send(text: string) {
      const payload = Buffer.from(text)
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      socket.write(Buffer.concat([header, payload]))
    },
    close() {
      closed = true
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]))
    },
  }
}

async function collect(events: AsyncIterableIterator<RunnerLiveEvent>, count: number) {
  const seen: RunnerLiveEvent[] = []
  for await (const event of events) {
    seen.push(event)
    if (seen.length === count) break
  }
  return seen
}

test("a host's WebSockets get exactly the SSE stream's events for the same turn, after the same checks", async () => {
  const { app, events, runner, session, store } = world()
  const accepted: string[] = []
  const sent: Array<{ sessionId: string; data: string }> = []
  const sockets: EventSockets = {
    // Node can't build a 101 response; the marker proves the route handed the upgrade to the host.
    accept: (sessionId) => {
      accepted.push(sessionId)
      return new Response(null, { status: 204, headers: { "x-test-socket": sessionId } })
    },
    send: (sessionId, data) => sent.push({ sessionId, data }),
  }
  events.useSockets(sockets)
  const upgrade = { ...auth, upgrade: "websocket", connection: "Upgrade" }

  assert.equal((await app.request(`/v1/sessions/${session}/events`, { headers: { upgrade: "websocket" } })).status, 401)
  assert.deepEqual(accepted, [], "no socket without the service token")
  const socket = await app.request(`/v1/sessions/${session}/events`, { headers: upgrade })
  assert.equal(socket.headers.get("x-test-socket"), session)
  // An id the runner never makes gets the stream, not a socket.
  const odd = new AbortController()
  const oddResponse = await app.request("/v1/sessions/not-a-session/events", { headers: upgrade, signal: odd.signal })
  assert.equal(oddResponse.headers.get("content-type"), "text/event-stream")
  odd.abort()
  await oddResponse.body?.cancel()
  assert.deepEqual(accepted, [session])

  const listening = new AbortController()
  const stream = await app.request(`/v1/sessions/${session}/events`, { headers: auth, signal: listening.signal })
  const data: string[] = []
  const reading = sseData(stream, data)
  await sleep(20)
  const other = store.createSession({ owner: "test" }).id
  assert.ok(runner.send({ sessionId: session, messageId: "msg_1", prompt: "Write a note", credentials: {} }).ok)
  assert.ok(runner.send({ sessionId: other, messageId: "msg_2", prompt: "Write a note", credentials: {} }).ok)
  await runner.idle()
  await sleep(50)
  listening.abort()
  await reading.stop()
  await reading.done

  const mine = sent.filter((entry) => entry.sessionId === session).map((entry) => entry.data)
  assert.ok(data.length > 4, `the turn streamed events: ${JSON.stringify(data)}`)
  assert.deepEqual(mine, data, "each socket message is one SSE data payload, in the same order")
  const types = new Set(mine.map((entry) => z.object({ type: z.string() }).parse(JSON.parse(entry)).type))
  assert.deepEqual(types, new Set(["changed", "text", "tool"]))
  assert.ok(sent.some((entry) => entry.sessionId === other), "another session's events go to its own sockets")
  store.close()
})

test("the Node host answers an upgrade without upgrading, and the client falls back to SSE", async () => {
  const { app, session, store } = world()
  const plain = new AbortController()
  const answered = await app.request(`/v1/sessions/${session}/events`, { headers: { ...auth, upgrade: "websocket", connection: "Upgrade" }, signal: plain.signal })
  assert.equal(answered.status, 200)
  assert.equal(answered.headers.get("content-type"), "text/event-stream")
  plain.abort()
  await answered.body?.cancel()

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const runner = client({ url: `http://127.0.0.1:${address.port}`, token })
  const closing = new AbortController()
  try {
    assert.equal(await runner.openEventsSocket(session, closing.signal), null)
    const sse = await runner.openEvents(session, closing.signal)
    assert.equal(sse?.status, 200)
    assert.equal(sse?.headers.get("content-type"), "text/event-stream")
  } finally {
    closing.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
  }
})

test("openEventsSocket sends the token and owner as headers, yields ready and the events, and ends when the socket does", async () => {
  const handshakes: IncomingMessage[] = []
  const server = createServer((_request, response) => response.writeHead(404).end())
  const accepted: Array<ReturnType<typeof acceptUpgrade>> = []
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    handshakes.push(request)
    const current = acceptUpgrade(request, socket)
    accepted.push(current)
    current.send(JSON.stringify({ type: "ready" }))
    current.send("pong")
    current.send(JSON.stringify({ type: "changed", messageId: "msg_1", status: "running" }))
    current.send(JSON.stringify({ type: "text", messageId: "msg_1", step: 0, delta: "x".repeat(300) }))
    current.send(JSON.stringify({ unknown: true }))
    current.send(JSON.stringify({ type: "tool", messageId: "msg_1", step: 0, tool: "bash" }))
  })
  const url = await listen(server)
  try {
    const owner = "test-org/member-a"
    const runner = client({ url, token, owner })
    const signal = new AbortController().signal
    const events = await runner.openEventsSocket("hs_example_session", signal)
    assert.ok(events)
    assert.deepEqual(await collect(events, 4), [
      { type: "ready" },
      { type: "changed", messageId: "msg_1", status: "running" },
      { type: "text", messageId: "msg_1", step: 0, delta: "x".repeat(300) },
      { type: "tool", messageId: "msg_1", step: 0, tool: "bash" },
    ])
    const [handshake] = handshakes
    assert.equal(handshake?.url, "/v1/sessions/hs_example_session/events")
    assert.equal(handshake?.headers.authorization, `Bearer ${token}`)
    assert.equal(handshake?.headers["x-openwork-headless-owner"], owner)
    assert.ok(!handshake?.url?.includes(token))

    // The runner closing the socket ends the events once the ones already sent are read.
    const again = await runner.openEventsSocket("hs_example_session", signal)
    assert.ok(again)
    await sleep(50)
    const current = accepted.at(-1)
    assert.ok(current)
    current.send(JSON.stringify({ type: "changed", messageId: "msg_2" }))
    current.close()
    const rest: RunnerLiveEvent[] = []
    for await (const event of again) rest.push(event)
    assert.deepEqual(rest.map((event) => event.type), ["ready", "changed", "text", "tool", "changed"])

    // Aborting ends a reader that is waiting.
    const stop = new AbortController()
    const third = await runner.openEventsSocket("hs_example_session", stop.signal)
    assert.ok(third)
    const read = collect(third, 100)
    await sleep(50)
    stop.abort()
    assert.equal((await read).length, 4)
  } finally {
    await closeServer(server)
  }
})

test("openEventsSocket gives null whenever there is no socket: no upgrade, refused, unreachable, or already aborted", async () => {
  const server = createServer((_request, response) => response.writeHead(404).end())
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket)
    if (request.url?.includes("refused")) return void socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}")
    // A runner that ignores the upgrade and streams SSE instead, as the Node host may.
    socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\nevent: ready\ndata: {}\n\n")
  })
  const url = await listen(server)
  try {
    const runner = client({ url, token })
    const signal = new AbortController().signal
    assert.equal(await runner.openEventsSocket("hs_example_session", signal), null)
    assert.equal(await runner.openEventsSocket("hs_refused_session", signal), null)
    assert.equal(await client({ url: "http://127.0.0.1:1", token }).openEventsSocket("hs_example_session", signal), null)
    assert.equal(await runner.openEventsSocket("hs_example_session", AbortSignal.abort()), null)
  } finally {
    await closeServer(server)
  }
})
