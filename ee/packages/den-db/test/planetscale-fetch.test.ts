import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createPlanetScaleDispatcher, createRetryingPlanetScaleFetch } from "../src/transient-retry.ts"

const standaloneRead = JSON.stringify({ query: "select id from member where id = 'a'", session: null })

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  // Like PlanetScale's edge: no Keep-Alive timeout hint, idle sockets left open.
  server.keepAliveTimeout = 0
  let connections = 0
  server.on("connection", () => { connections += 1 })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/psdb.v1alpha1.Database/Execute`, connections: () => connections, server }
}

async function close(server: Server, dispatcher: { close(): Promise<void> }) {
  await dispatcher.close()
  server.closeAllConnections()
  server.close()
}

test("an idle gap longer than undici's 4 s default reuses the same socket", async () => {
  const { url, connections, server } = await listen((_req, res) => res.end("{}"))
  const dispatcher = createPlanetScaleDispatcher()
  const fetch = createRetryingPlanetScaleFetch(dispatcher)
  try {
    await (await fetch(url, { method: "POST", body: standaloneRead })).json()
    await delay(4_500)
    await (await fetch(url, { method: "POST", body: standaloneRead })).json()
    assert.equal(connections(), 1)
  } finally {
    await close(server, dispatcher)
  }
})

test("a standalone read still retries once after the socket closes", async () => {
  let requests = 0
  const { url, server } = await listen((req, res) => {
    requests += 1
    if (requests === 1) req.socket.destroy()
    else res.end("{}")
  })
  const dispatcher = createPlanetScaleDispatcher()
  const fetch = createRetryingPlanetScaleFetch(dispatcher)
  try {
    const response = await fetch(url, { method: "POST", body: standaloneRead })
    assert.equal(response.status, 200)
    assert.equal(requests, 2)
  } finally {
    await close(server, dispatcher)
  }
})
