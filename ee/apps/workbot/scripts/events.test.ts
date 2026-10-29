/**
 * Workbot's live-events relay: with `stepTurns` (saved step turns) it reads the runner's events over a WebSocket,
 * falling back to the runner's SSE when the runner doesn't upgrade; without it, SSE only. The page gets the same SSE
 * either way, or a 409 that says when to try again.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { test } from "node:test"
import { Hono } from "hono"
import { workbotOwner, workbotSessionId } from "@openwork-ee/workbot-server"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const token = "x".repeat(32)
const runnerEvents = (via: string) => [
  { type: "changed", messageId: "wb_message_001", status: "running" },
  { type: "text", messageId: "wb_message_001", step: 0, delta: via },
  { type: "tool", messageId: "wb_message_001", step: 0, tool: "bash" },
  // Not a Workbot turn: never reaches the page.
  { type: "changed", messageId: "slack_message", status: "running" },
]
const pageEvents = (via: string) => [
  { type: "changed", messageId: "message_001", status: "running" },
  { type: "text", messageId: "message_001", step: 0, delta: via },
  { type: "working", messageId: "message_001", step: 0, on: "computer", background: true },
]

/** The server half of a WebSocket handshake, and unmasked text frames: enough to stand in for a runner that upgrades. */
function acceptUpgrade(request: IncomingMessage, socket: Duplex) {
  const accept = createHash("sha1").update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"))
  const send = (text: string) => {
    const payload = Buffer.from(text)
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
  }
  return { send, close: () => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])) }
}

/** Reads a page stream to its end: its `ready`, then the events. */
async function pageStream(response: Response) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  const blocks = (await response.text()).split("\n\n").filter((block) => block && !block.startsWith(":"))
  assert.match(blocks[0] ?? "", /^event: ready/)
  return blocks.slice(1).map((block) => JSON.parse(block.replace(/^data: /, "")))
}

/** Workbot's routes against a runner on `port`, for the member (and their flags) named in each request's test headers. */
function workbotEvents(port: number) {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: `http://127.0.0.1:${port}`, WORKBOT_RUNNER_TOKEN: token, WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), runToken: async () => ({ token: "scoped-test-token" }) }
  const auth = createAuth({ config, den })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    const member = c.req.header("x-test-member") ?? "member_a"
    const who = denSessionSchema.parse({ user: { id: member, name: "Alex", email: "alex@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: member, enabled: c.req.header("x-test-workbot") !== "off", canSchedule: false, stepTurns: c.req.header("x-test-step-turns") === "on" })
    c.set("member", { session: { id: member, userId: member, organizationId: who.organization.id, tokens: { accessToken: "test", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "test", den: who })
    await next()
  } })
  return (headers: Record<string, string>) => app.request("http://localhost:3090/v1/workbot/events", { headers })
}

test("Workbot reads live events over the runner's socket only with stepTurns, and falls back to SSE", async () => {
  let upgrades = true
  const sockets: IncomingMessage[] = []
  const streams: IncomingMessage[] = []
  const open = new Set<Duplex>()
  const runner = createServer((request, response) => {
    // Workbot lists the person's chats once per process to find which session each chat lives in.
    if (request.url?.startsWith("/v1/sessions?")) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: [] }))
    streams.push(request)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(["event: ready\ndata: {}", ": keep-alive", ...runnerEvents("via sse").map((event) => `data: ${JSON.stringify(event)}`), ""].join("\n\n"))
  })
  runner.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    open.add(socket)
    socket.on("error", () => undefined)
    sockets.push(request)
    // A runner without sockets (the Node host) answers without upgrading.
    if (!upgrades) return void socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 0\r\n\r\n")
    const live = acceptUpgrade(request, socket)
    live.send(JSON.stringify({ type: "ready" }))
    for (const event of runnerEvents("via socket")) live.send(JSON.stringify(event))
    // The runner moved the cell: the socket ends, and so does the page's stream.
    setTimeout(live.close, 50)
  })
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve))
  const address = runner.address()
  assert.ok(address && typeof address === "object")
  try {
    const events = workbotEvents(address.port)

    // Off: SSE only, as before.
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_a" })), pageEvents("via sse"))
    assert.equal(sockets.length, 0)
    assert.equal(streams.length, 1)

    // On: the socket, with the service token and owner in its headers; the page gets the same SSE.
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_b", "x-test-step-turns": "on" })), pageEvents("via socket"))
    assert.equal(sockets.length, 1)
    assert.equal(streams.length, 1)
    const [handshake] = sockets
    assert.equal(handshake?.url, `/v1/sessions/${workbotSessionId("org_example", "member_b")}/events`)
    assert.equal(handshake?.headers.authorization, `Bearer ${token}`)
    assert.equal(handshake?.headers["x-openwork-headless-owner"], workbotOwner("org_example", "member_b"))

    // On, but the runner doesn't upgrade: SSE.
    upgrades = false
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_c", "x-test-step-turns": "on" })), pageEvents("via sse"))
    assert.equal(sockets.length, 2)
    assert.equal(streams.length, 2)
    // That person's sockets rest for a while: straight to SSE, no handshake.
    upgrades = true
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_c", "x-test-step-turns": "on" })), pageEvents("via sse"))
    assert.equal(sockets.length, 2)
    // So do those of a person whose socket ended within seconds (member_b's, above).
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_b", "x-test-step-turns": "on" })), pageEvents("via sse"))
    assert.equal(sockets.length, 2)
    // Everyone else still gets a socket.
    assert.deepEqual(await pageStream(await events({ "x-test-member": "member_d", "x-test-step-turns": "on" })), pageEvents("via socket"))
    assert.equal(sockets.length, 3)
  } finally {
    runner.closeAllConnections()
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => runner.close(() => resolve()))
  }
})

test("Live events the runner can't open: 409 with Retry-After, and why, logged at most once a minute", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined)
  const runner = createServer((request, response) => {
    if (request.url?.startsWith("/v1/sessions?")) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: [] }))
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "unavailable" }))
  })
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve))
  const address = runner.address()
  assert.ok(address && typeof address === "object")
  try {
    const events = workbotEvents(address.port)
    for (const member of ["member_a", "member_b"]) {
      const refused = await events({ "x-test-member": member })
      assert.equal(refused.status, 409)
      assert.equal(refused.headers.get("retry-after"), "5")
      assert.deepEqual(await refused.json(), { error: "workbot_runner_unavailable" })
    }
    // The first reason is logged; the second waits for the next minute's line.
    assert.deepEqual(logged.mock.calls.map((call) => call.arguments), [["[workbot] live events unavailable", { runner_refused: 1 }]])

    // Workbot off for the organization: the page stops trying, so there's no Retry-After.
    const off = await events({ "x-test-member": "member_c", "x-test-workbot": "off" })
    assert.equal(off.status, 409)
    assert.equal(off.headers.get("retry-after"), null)
    assert.deepEqual(await off.json(), { error: "workbot_not_enabled" })
  } finally {
    runner.closeAllConnections()
    await new Promise<void>((resolve) => runner.close(() => resolve()))
  }
})
