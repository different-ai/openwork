import assert from "node:assert/strict"
import { once } from "node:events"
import { Agent, createServer, request, Server } from "node:http"
import type { Socket } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { serveDenHttp } from "../src/http-server.ts"

// Like cloudflared's Go http.Transport, this proxy pool uses its own 90s idle
// expiration rather than interpreting the optional Keep-Alive response hint.
class OriginPool extends Agent {
  keepSocketAlive(socket: Socket) {
    socket.setKeepAlive(true, 30_000)
    socket.setTimeout(90_000)
    socket.unref()
    return true
  }
}

async function start(fetch: Parameters<typeof serveDenHttp>[0]["fetch"]) {
  const server = serveDenHttp({ fetch, port: 0, hostname: "127.0.0.1" })
  assert.ok(server instanceof Server)
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return { server, port: address.port }
}

function post(port: number, agent: Agent) {
  return new Promise<{ status: number | undefined; body: string; reused: boolean }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", agent, headers: { "content-length": "2" } }, (res) => {
      res.setEncoding("utf8")
      let body = ""
      res.on("data", (chunk: string) => { body += chunk })
      res.on("error", reject)
      res.on("end", () => resolve({ status: res.statusCode, body, reused: req.reusedSocket }))
    })
    req.on("error", reject)
    req.end("{}")
  })
}

async function close(server: Server, agent: Agent) {
  agent.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

test("a proxy can reuse an idle origin socket beyond Node's former six-second close boundary", { timeout: 12_000 }, async () => {
  let calls = 0
  let connections = 0
  const { server, port } = await start(async req => {
    assert.equal(await req.text(), "{}")
    calls++
    return Response.json({ ok: true })
  })
  server.on("connection", () => { connections++ })
  const agent = new OriginPool({ keepAlive: true, maxSockets: 1 })
  try {
    assert.equal((await post(port, agent)).status, 200)
    // Node 24's default is 5s + 1s keepAliveTimeoutBuffer. Use real timers:
    // the regression concerns a live TCP socket, not a mocked config value.
    await delay(6_250)
    const second = await post(port, agent)
    assert.equal(second.status, 200)
    assert.deepEqual(JSON.parse(second.body), { ok: true })
    assert.equal(second.reused, true, "the proxy must not race an origin-initiated idle close")
    assert.equal(connections, 1)
    assert.equal(calls, 2, "no application request is replayed")
  } finally {
    await close(server, agent)
  }
})

test("origin lifetime exceeds the proxy pool without relaxing incomplete-request protection", async () => {
  const defaults = createServer()
  const { server } = await start(() => new Response("ok"))
  try {
    assert.ok(server.keepAliveTimeout > 90_000)
    assert.ok(server.keepAliveTimeout <= 180_000, "idle connections remain bounded")
    assert.equal(server.headersTimeout, defaults.headersTimeout)
    assert.equal(server.requestTimeout, defaults.requestTimeout)
    assert.equal(server.timeout, defaults.timeout)
  } finally {
    await close(server, new Agent())
  }
})

test("shutdown closes idle pooled connections without waiting for the keep-alive lifetime", { timeout: 2_000 }, async () => {
  const { server, port } = await start(async req => { await req.text(); return new Response("ok") })
  const agent = new OriginPool({ keepAlive: true, maxSockets: 1 })
  try {
    await post(port, agent)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.equal(server.listening, false)
  } finally {
    agent.destroy()
    server.closeAllConnections()
  }
})
