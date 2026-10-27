import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { Server, request as httpRequest, type IncomingMessage } from "node:http"
import { test } from "node:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { serveDenHttp } from "../src/http-server.js"
import { installGracefulShutdown, trackEventStreams, type GracefulShutdownOptions } from "../src/graceful-shutdown.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** A real den-api HTTP server with routes that stay in flight until the test lets them finish. */
async function startServer(options: Partial<GracefulShutdownOptions> = {}) {
  const slow = gate()
  const slowStarted = gate()
  const postStream = gate()
  const app = new Hono()
  app.get("/fast", (c) => c.text("fast"))
  app.post("/slow", async (c) => {
    slowStarted.open()
    await slow.promise
    return c.text("finished")
  })
  // Long-lived notification stream, like /v1/automation-runners/events or an MCP GET stream.
  app.get("/events", (c) => streamSSE(c, async (stream) => {
    while (!stream.aborted) {
      await stream.writeSSE({ event: "keepalive", data: "{}" })
      await stream.sleep(20)
    }
  }))
  // A POST answered with an event stream (an MCP tool call): real work that must drain.
  app.post("/tool-call", (c) => streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "progress", data: "started" })
    await postStream.promise
    await stream.writeSSE({ event: "result", data: "done" })
  }))

  const server = serveDenHttp({ fetch: trackEventStreams(app.fetch), port: 0, hostname: "127.0.0.1" })
  if (!(server instanceof Server)) throw new Error("expected an HTTP/1.1 server")
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected a TCP address")
  const { port } = address

  const signals = new EventEmitter()
  const exits: number[] = []
  const logs: string[] = []
  const shutdown = installGracefulShutdown(server, {
    drainTimeoutMs: 5_000,
    sweepMs: 20,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    processTarget: { on: (event, listener) => { signals.on(event, listener); return process }, off: (event, listener) => { signals.off(event, listener); return process } },
    ...options,
  })

  return { server, port, slow, slowStarted, postStream, signals, exits, logs, shutdown }
}

type Reply = { status: number; headers: IncomingMessage["headers"]; body: string; error?: string }

/** Raw HTTP request on a keep-alive agent-free socket, so headers like Connection are visible. */
function call(port: number, method: string, path: string): Promise<Reply> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on("error", (error) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, error: error.message }))
      res.on("aborted", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, error: "aborted" }))
    })
    req.on("error", (error) => resolve({ status: 0, headers: {}, body: "", error: error.message }))
    req.end()
  })
}

test("SIGTERM lets an in-flight request finish, asks the caller to reconnect, and refuses new connections", async () => {
  const den = await startServer()
  const inFlight = call(den.port, "POST", "/slow")
  await den.slowStarted.promise

  den.signals.emit("SIGTERM")
  await sleep(50)
  assert.equal(den.shutdown.isDraining(), true)
  assert.deepEqual(den.exits, [], "still draining while the request runs")

  const refused = await call(den.port, "GET", "/fast")
  assert.equal(refused.status, 0, "a new connection is not accepted while draining")

  await sleep(200)
  assert.deepEqual(den.exits, [], "the old 3s cut-off is gone: a slow request is not killed")
  den.slow.open()
  const reply = await inFlight
  assert.equal(reply.error, undefined)
  assert.equal(reply.status, 200)
  assert.equal(reply.body, "finished")
  assert.equal(reply.headers.connection, "close", "the caller is told to open a fresh connection elsewhere")

  await sleep(50)
  assert.deepEqual(den.exits, [0])
  assert.equal(den.server.listening, false)
  den.shutdown.dispose()
})

test("draining closes GET event streams at once but lets a POST event stream finish", async () => {
  const den = await startServer()
  const events = call(den.port, "GET", "/events")
  const toolCall = call(den.port, "POST", "/tool-call")
  await sleep(100)

  den.signals.emit("SIGTERM")
  const closed = await events
  assert.equal(closed.status, 200)
  assert.ok(closed.body.includes("keepalive"), "the stream was live before shutdown")
  assert.ok(closed.error, "the notification stream is closed so its client resumes on the new instance")

  await sleep(100)
  assert.deepEqual(den.exits, [], "the tool call is still draining")
  den.postStream.open()
  const result = await toolCall
  assert.equal(result.error, undefined)
  assert.ok(result.body.includes("event: result"), "the tool call delivered its result")

  await sleep(50)
  assert.deepEqual(den.exits, [0])
  den.shutdown.dispose()
})

test("background work stops alongside the request drain and both are awaited", async () => {
  const background = gate()
  let backgroundStarted = false
  let afterStopRan = false
  const den = await startServer({
    stopBackgroundWork: async () => {
      backgroundStarted = true
      await background.promise
    },
    afterStop: async () => { afterStopRan = true },
  })
  const inFlight = call(den.port, "POST", "/slow")
  await den.slowStarted.promise

  den.signals.emit("SIGTERM")
  await sleep(20)
  assert.equal(backgroundStarted, true, "background loops stop while requests drain, not after")

  den.slow.open()
  assert.equal((await inFlight).status, 200)
  await sleep(100)
  assert.deepEqual(den.exits, [], "a background job that is still finishing holds the exit")
  assert.equal(afterStopRan, false)

  background.open()
  await sleep(50)
  assert.equal(afterStopRan, true)
  assert.deepEqual(den.exits, [0])
  den.shutdown.dispose()
})

test("the drain deadline closes requests that outlive it, then exits", async () => {
  const den = await startServer({ drainTimeoutMs: 150 })
  const inFlight = call(den.port, "POST", "/slow")
  await den.slowStarted.promise

  den.signals.emit("SIGTERM")
  const reply = await inFlight
  assert.ok(reply.error, "the stuck request is cut only at the deadline")
  await sleep(50)
  assert.deepEqual(den.exits, [0])
  assert.ok(den.logs.some((line) => line.includes("timed out")))
  den.slow.open()
  den.shutdown.dispose()
})

test("a second signal exits immediately", async () => {
  const den = await startServer()
  const inFlight = call(den.port, "POST", "/slow")
  await den.slowStarted.promise

  den.signals.emit("SIGTERM")
  den.signals.emit("SIGTERM")
  assert.deepEqual(den.exits, [1])
  den.slow.open()
  await inFlight
  den.shutdown.dispose()
})
