import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createServer, request, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { installGracefulShutdown, waitForQueueIdle } from "../src/shutdown.js"

type Harness = { server: Server; port: number; signals: EventEmitter; exits: number[]; exited: Promise<number> }

async function harness(handler: Parameters<typeof createServer>[1], drainTimeoutMs: number, afterDrain?: () => Promise<void>): Promise<Harness> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const signals = new EventEmitter()
  const exits: number[] = []
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  installGracefulShutdown(server, {
    drainTimeoutMs,
    afterDrain,
    idleSweepMs: 20,
    processTarget: signals,
    log: () => {},
    exit: (code) => { exits.push(code); resolveExit(code) },
  })
  const { port } = server.address() as AddressInfo
  return { server, port, signals, exits, exited }
}

function get(port: number, path: string, agent?: import("node:http").Agent) {
  return new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end()
  })
}

test("SIGTERM lets an in-flight stream finish, refuses new connections, then exits 0", async () => {
  let afterDrainRan = false
  const h = await harness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: one\n\n")
    setTimeout(() => res.end("data: two\n\n"), 200)
  }, 5_000, async () => { afterDrainRan = true })

  const inflight = get(h.port, "/stream")
  await new Promise((resolve) => setTimeout(resolve, 50))
  h.signals.emit("SIGTERM")

  await assert.rejects(get(h.port, "/new"), /ECONNREFUSED|ECONNRESET/)
  const result = await inflight
  assert.equal(result.status, 200)
  assert.equal(result.body, "data: one\n\ndata: two\n\n")
  assert.equal(await h.exited, 0)
  assert.equal(afterDrainRan, true)
})

test("keep-alive requests that arrive while draining are told to reconnect", async () => {
  const { Agent } = await import("node:http")
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  let release: () => void = () => {}
  const h = await harness((req, res) => {
    if (req.url === "/slow") { release = () => res.end("slow"); return }
    res.end("ok")
  }, 5_000)

  // Open a pooled connection, then start a slow request on a second socket.
  await get(h.port, "/warm", agent)
  const slow = get(h.port, "/slow")
  await new Promise((resolve) => setTimeout(resolve, 30))
  h.signals.emit("SIGTERM")
  await new Promise((resolve) => setTimeout(resolve, 60))

  // The idle pooled socket was closed by the sweep, so the agent must reconnect and is refused.
  await assert.rejects(get(h.port, "/after", agent), /ECONNREFUSED|ECONNRESET|socket hang up/)
  release()
  assert.equal((await slow).body, "slow")
  assert.equal(await h.exited, 0)
  agent.destroy()
})

test("responses that start after SIGTERM carry Connection: close", async () => {
  const { Agent } = await import("node:http")
  const agent = new Agent({ keepAlive: true })
  const h = await harness((_req, res) => { setTimeout(() => res.end("late"), 100) }, 5_000)
  const late = get(h.port, "/late", agent)
  await new Promise((resolve) => setTimeout(resolve, 30))
  h.signals.emit("SIGTERM")
  const result = await late
  assert.equal(result.body, "late")
  assert.equal(result.connection, "close")
  assert.equal(await h.exited, 0)
  agent.destroy()
})

test("drain deadline closes stuck requests and still exits 0", async () => {
  const h = await harness((_req, res) => { res.writeHead(200); res.write("start") }, 100)
  const stuck = get(h.port, "/stuck").catch((error: Error) => error)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const startedAt = Date.now()
  h.signals.emit("SIGTERM")
  assert.equal(await h.exited, 0)
  assert.ok(Date.now() - startedAt < 2_000)
  await stuck
})

test("a second signal exits 1 immediately", async () => {
  const h = await harness((_req, res) => { res.writeHead(200); res.write("start") }, 10_000)
  const stuck = get(h.port, "/stuck").catch((error: Error) => error)
  await new Promise((resolve) => setTimeout(resolve, 30))
  h.signals.emit("SIGTERM")
  h.signals.emit("SIGINT")
  assert.deepEqual(h.exits, [1])
  h.server.closeAllConnections()
  await stuck
})

test("waitForQueueIdle resolves once the queue is empty", async () => {
  let remaining = 3
  await waitForQueueIdle(() => ({ active: remaining > 0 ? remaining-- : 0, queued: 0 }), 5)
  assert.equal(remaining, 0)
})
