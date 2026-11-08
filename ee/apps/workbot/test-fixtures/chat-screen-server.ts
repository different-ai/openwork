import type { IncomingMessage, ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { scenarios, type FixtureThread, type FixtureTurn } from "./chat-screen-scenarios.js"
import { fixtureRemoteJobs } from "./remote-jobs.js"

let remoteStopped = false

/**
 * Test-only: serves chat-screen.tsx with Workbot's Vite config and answers the page's `/v1/workbot` requests from an
 * in-memory conversation per scenario. Messages sent get a short canned answer; uploads are kept in memory.
 *
 *   pnpm --filter @openwork-ee/workbot exec tsx test-fixtures/chat-screen-server.ts [port]
 */
type Kept = { id: string; name: string; mediaType: string; size: number; createdAt: number; source: "user"; bytes: Buffer }

const threads = new Map<string, FixtureThread>()
const files = new Map<string, Kept>()
const thread = (name: string) => {
  let found = threads.get(name)
  if (!found) {
    found = (scenarios[name] ?? scenarios.bubbles)()
    threads.set(name, found)
  }
  return found
}

const body = (request: IncomingMessage) => new Promise<Buffer>((resolve) => {
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => resolve(Buffer.concat(chunks)))
})
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(value))
}

async function answer(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://fixture")
  const name = String(request.headers["x-fixture-scenario"] ?? "bubbles")
  const current = thread(name)
  const path = url.pathname
  if (request.method === "GET" && path === "/v1/workbot") return json(response, 200, { available: true, ...current })
  if (path === "/v1/workbot/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    response.write("event: ready\ndata: {}\n\n")
    const ping = setInterval(() => response.write(": fixture\n\n"), 10_000)
    response.on("close", () => clearInterval(ping))
    return
  }
  if (path === "/v1/workbot/computer/viewer" && process.env.WORKBOT_FIXTURE_FRAME) return json(response, 200, {
    state: "connected", expiresAt: Date.now() + 60_000, paused: false, url: `ws://${request.headers.host}/vnc/${"f".repeat(43)}`,
  })
  if (request.method === "POST" && path === "/v1/workbot/messages") {
    const input = JSON.parse((await body(request)).toString("utf8")) as { id: string; text: string; attachments?: string[] }
    const now = Date.now()
    const attachments = (input.attachments ?? []).flatMap((id) => {
      const file = files.get(id)
      return file ? [{ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size }] : []
    })
    const turn: FixtureTurn = { id: input.id, text: input.text, sentAt: now, finishedAt: now, status: "done", attachments, parts: [{ kind: "text", text: "Got it.", step: 0 }], modelSteps: 1, error: null }
    current.turns.push(turn)
    return json(response, 202, { ok: true })
  }
  if (request.method === "POST" && path === "/v1/workbot/files") {
    const bytes = await body(request)
    const id = `f${files.size + 1}`
    const kept: Kept = { id, name: url.searchParams.get("name") ?? "file", mediaType: String(request.headers["content-type"] ?? "application/octet-stream"), size: bytes.length, createdAt: Date.now(), source: "user", bytes }
    files.set(id, kept)
    const { bytes: _bytes, ...file } = kept
    return json(response, 201, file)
  }
  const file = /^\/v1\/workbot\/files\/([^/]+)$/.exec(path)
  if (request.method === "GET" && file) {
    const kept = files.get(file[1] ?? "")
    if (!kept) return json(response, 404, { error: "not_found" })
    response.setHeader("Content-Type", kept.mediaType)
    return response.end(kept.bytes)
  }
  if (path === "/v1/workbot/remote-jobs") return json(response, 200, { jobs: name === "remote" ? fixtureRemoteJobs(remoteStopped) : [], hasEarlier: false })
  if (path.startsWith("/v1/workbot/remote-jobs/")) {
    if (request.method === "POST" && path.endsWith("/stop")) { remoteStopped = true; return json(response, 200, { state: "stopped" }) }
    return json(response, 200, { state: "ready", canStop: !remoteStopped, messageId: "fixture-user", messages: [
      { id: "fixture-user", role: "user", text: "Check the mobile browser flow and report what works." },
      { id: "fixture-assistant", role: "assistant", text: "The mobile layout is checked. I'm verifying the last browser step." },
    ] })
  }
  if (path === "/v1/workbot/files") return json(response, 200, { enabled: true, files: [...files.values()].map(({ bytes: _bytes, ...rest }) => rest) })
  if (!path.startsWith("/v1/workbot/remote-jobs/") && (path === "/v1/workbot/stop" || path.endsWith("/stop"))) return json(response, 200, { ok: true })
  if (path === "/v1/workbot/connections") return json(response, 200, { connections: [
    { id: "c1", name: "Gmail", app: "gmail", ready: true, connectUrl: null },
    { id: "c2", name: "Google Calendar", app: "googleCalendar", ready: true, connectUrl: null },
    { id: "c3", name: "Slack", app: "slack", ready: false, connectUrl: "https://den.example.test/connect/slack" },
  ] })
  if (path === "/v1/workbot/memory") return json(response, 200, { files: [
    { name: "about-me.md", updatedAt: Date.now() - 2 * 86_400_000, content: "# Sam\n- Founder at Example Team; works mostly from a phone.\n- Prefers short answers, then details on request.\n- Cooks salmon with a predictive thermometer." },
    { name: "projects.md", updatedAt: Date.now() - 6 * 86_400_000, content: "- Workbot UI fixes (Nov 7 list)\n- 3D room planner for the new office" },
  ] })
  if (path === "/v1/workbot/chats") return json(response, 200, { main: { updatedAt: Date.now() }, side: [] })
  // No live stream: the page reads the conversation again on its own.
  return json(response, 404, { error: "not_found" })
}

const entry = fileURLToPath(new URL("./chat-screen.tsx", import.meta.url))
const vite = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { port: Number(process.argv[2] ?? 3091), strictPort: true },
  plugins: [{
    name: "workbot-chat-screen-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/"
        if (url.startsWith("/v1/workbot")) { void answer(request, response); return }
        if (url === "/" || url.startsWith("/?") || url.startsWith("/documents") || url.startsWith("/browser") || url.startsWith("/computer")) {
          void server.transformIndexHtml(url, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><title>Workbot</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`)
            .then((html) => { response.setHeader("Content-Type", "text/html"); response.end(html) })
          return
        }
        next()
      })
    },
  }],
})
// Test-only screencast: the caller supplies a JPEG captured from an actual page. It is intentionally not a browser
// runtime: UI tests exercise real frame drawing/retention without signing into a runner or claiming an external task.
if (process.env.WORKBOT_FIXTURE_FRAME) vite.httpServer?.on("upgrade", (request, socket) => {
  if (!request.url?.startsWith("/screencast/")) return
  const key = request.headers["sec-websocket-key"]
  if (!key) { socket.destroy(); return }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const frame = (opcode: number, bytes: Buffer) => {
    const head = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65_536 ? 4 : 10)
    head[0] = 0x80 | opcode
    if (bytes.length < 126) head[1] = bytes.length
    else if (bytes.length < 65_536) { head[1] = 126; head.writeUInt16BE(bytes.length, 2) }
    else { head[1] = 127; head.writeBigUInt64BE(BigInt(bytes.length), 2) }
    if (!socket.destroyed) socket.write(Buffer.concat([head, bytes]))
  }
  socket.on("error", () => socket.destroy())
  void readFile(process.env.WORKBOT_FIXTURE_FRAME!).then((bytes) => {
    frame(1, Buffer.from(JSON.stringify({ type: "page", id: "fixture", title: "Example Domain", url: "https://example.com" })))
    frame(2, bytes)
  }).catch(() => socket.destroy())
})
await vite.listen()
console.log(vite.resolvedUrls?.local[0])
