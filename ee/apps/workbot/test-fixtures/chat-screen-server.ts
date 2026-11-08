import type { IncomingMessage, ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { exaAt, GOOGLE_EVENTS, googleAt, scenarios, type FixtureThread, type FixtureTurn } from "./chat-screen-scenarios.js"
import { fixtureRemoteJobs, fixtureStaleRemoteJobs } from "./remote-jobs.js"

// Observes real client requests; the fixture never changes browser controls or rendered UI.
const browserRequests: Array<{ path: string; body: unknown }> = []
const browserControlHeld = new Set<string>()
let remoteStopped = false
let googleStarted: number | null = null
let exaStarted: number | null = null
/** Ben's Exa request: the first search, the second, both done while it reads, then the answer (ms from first read). */
const EXA_PHASES_MS = [3_000, 6_000, 9_000]
const GOOGLE_EVENT_GAP_MS = 1_500
const GOOGLE_STORED_MS = 4_500
const GOOGLE_DONE_MS = 9_000

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
  // "google" replays Nov 8's browser request in real time from the page's first read: GOOGLE_EVENTS while the call is
  // written, the stored running step at GOOGLE_STORED_MS, done at GOOGLE_DONE_MS. A reload afterwards reads it done.
  if (name === "google") {
    googleStarted ??= Date.now()
    const since = Date.now() - googleStarted
    threads.set(name, googleAt(since < GOOGLE_STORED_MS ? 0 : since < GOOGLE_DONE_MS ? 1 : 2))
  }
  // "exa" replays the Exa request from the page's first read (EXA_PHASES_MS); `?exa=reset` starts it over.
  if (name === "exa") {
    if (url.searchParams.get("exa") === "reset") exaStarted = null
    exaStarted ??= Date.now()
    const since = Date.now() - exaStarted
    const phase = EXA_PHASES_MS.findIndex((at) => since < at)
    threads.set(name, exaAt(phase === -1 ? 3 : phase === 0 ? 0 : phase === 1 ? 1 : 2))
  }
  const current = thread(name)
  const path = url.pathname
  if (request.method === "GET" && path === "/v1/workbot") return json(response, 200, { available: true, ...current })
  if (path === "/v1/workbot/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    response.write("event: ready\ndata: {}\n\n")
    if (name === "google" && googleStarted !== null) {
      const since = Date.now() - googleStarted
      const send = (event: unknown) => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`) }
      const timers = [
        ...GOOGLE_EVENTS.map((event, index) => setTimeout(() => send(event), Math.max(0, index * GOOGLE_EVENT_GAP_MS - since))),
        ...[GOOGLE_STORED_MS, GOOGLE_DONE_MS].map((at) => setTimeout(() => send({ type: "changed", messageId: "g1" }), Math.max(0, at - since + 50))),
      ]
      if (since >= GOOGLE_STORED_MS) for (const timer of timers.slice(0, GOOGLE_EVENTS.length)) clearTimeout(timer)
      response.on("close", () => timers.forEach(clearTimeout))
    }
    if (name === "exa" && exaStarted !== null) {
      const since = Date.now() - exaStarted
      const timers = EXA_PHASES_MS.map((at) => setTimeout(() => { if (!response.writableEnded) response.write(`data: ${JSON.stringify({ type: "changed", messageId: "x1" })}\n\n`) }, Math.max(0, at - since + 50)))
      response.on("close", () => timers.forEach(clearTimeout))
    }
    const ping = setInterval(() => response.write(": fixture\n\n"), 10_000)
    response.on("close", () => clearInterval(ping))
    return
  }
  if (path === "/v1/workbot/computer/viewer" && process.env.WORKBOT_FIXTURE_FRAME) {
    const input: unknown = JSON.parse((await body(request)).toString("utf8"))
    browserRequests.push({ path, body: input })
    if (typeof input === "object" && input !== null && "control" in input && input.control === true) browserControlHeld.add(name)
    return json(response, 200, { state: "connected", expiresAt: Date.now() + 60_000, paused: browserControlHeld.has(name), url: `ws://${request.headers.host}/vnc/${"f".repeat(43)}` })
  }
  if (path === "/v1/workbot/computer/action" && request.method === "POST") {
    const input: unknown = JSON.parse((await body(request)).toString("utf8"))
    browserRequests.push({ path, body: input })
    if (typeof input === "object" && input !== null && "action" in input && input.action === "continue") browserControlHeld.delete(name)
    return json(response, 200, { ok: true })
  }
  if (path === "/v1/workbot/stop" && request.method === "POST") {
    browserRequests.push({ path, body: null })
    current.status = "idle"
    for (const turn of current.turns) {
      if (turn.status !== "working" && turn.status !== "queued") continue
      turn.status = "stopped"
      turn.finishedAt = Date.now()
      for (const part of turn.parts) if (part.kind === "steps") {
        for (const step of part.steps) if (typeof step === "object" && step !== null && "status" in step && step.status === "running") {
          Object.assign(step, { status: "done", reason: "Stopped before the browser task finished.", finishedAt: Date.now() })
        }
      }
    }
    return json(response, 200, { ok: true })
  }
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
  if (path === "/v1/workbot/remote-jobs") {
    // `remote-stale`: the refresh failed and every row keeps its last verified state.
    if (name === "remote-stale") return json(response, 200, { jobs: fixtureStaleRemoteJobs(), hasEarlier: false, statusError: "unavailable" })
    return json(response, 200, { jobs: name === "remote" ? fixtureRemoteJobs(remoteStopped) : [], hasEarlier: false })
  }
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
  ], apps: fixtureApps })
  if (path === "/v1/workbot/memory") return json(response, 200, { files: [
    { name: "about-me.md", updatedAt: Date.now() - 2 * 86_400_000, content: "# Sam\n- Founder at Example Team; works mostly from a phone.\n- Prefers short answers, then details on request.\n- Cooks salmon with a predictive thermometer." },
    { name: "projects.md", updatedAt: Date.now() - 6 * 86_400_000, content: "- Workbot UI fixes (Nov 7 list)\n- 3D room planner for the new office" },
  ] })
  if (path === "/v1/workbot/chats") return json(response, 200, { main: { updatedAt: Date.now() - 60_000 }, side: request.headers["x-fixture-chat-list"] === "1" ? fixtureSideChats() : [] })
  // Documents (`?documents=1`): a small Drive with recent files, one folder, and a text file that opens.
  if (path === "/v1/workbot/documents/v1/capabilities/google-workspace/drive-files") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase()
    const folder = url.searchParams.get("folderId")
    const listed = fixtureDrive.filter((file) => (folder && folder !== "root" ? file.parent === folder : url.searchParams.get("filesOnly") === "true" ? file.mimeType !== FOLDER : file.parent === "root") && file.name.toLowerCase().includes(query))
    return json(response, 200, { ok: true, files: listed.map(({ parent: _parent, text: _text, ...file }) => file) })
  }
  const driveFile = /^\/v1\/workbot\/documents\/v1\/documents\/google-drive\/files\/([^/]+)\/(metadata|editor)$/.exec(path)
  if (driveFile) {
    const found = fixtureDrive.find((file) => file.id === driveFile[1])
    if (!found) return json(response, 404, { error: "not_found" })
    if (driveFile[2] === "metadata") return json(response, 200, { id: found.id, name: found.name, mimeType: found.mimeType, modifiedTime: found.modifiedTime, size: found.size === null ? null : Number(found.size), openUrl: found.webViewLink })
    if (request.method === "POST") return json(response, 200, { ok: true })
    return json(response, 200, { kind: "text", connectionId: "google-workspace", fileId: found.id, name: found.name, revision: "1", canEdit: true, text: found.text ?? "" })
  }
  // No live stream: the page reads the conversation again on its own.
  return json(response, 404, { error: "not_found" })
}

/** The profile's Apps list: every app the person can use, connected or not, as Den sorts it (Connected first). */
const app = (id: string, name: string, status: "connected" | "needs_sign_in" | "not_connected" | "needs_attention", action: "connect" | "ask_admin" | "admin_settings" | null, managedBy: "you" | "organization" = action === "connect" ? "you" : "organization") => ({
  id, name, nativeProviderKey: null, authType: "oauth" as const, status, managedBy, action,
  connectMode: action === "connect" ? "external" as const : "admin" as const,
  connectUrl: action === "connect" ? `https://den.example.test/dashboard/your-connections?connectionId=${id}` : null,
  ready: status === "connected",
})
const fixtureApps = [
  app("c1", "Gmail", "connected", null, "you"),
  app("c2", "Google Calendar", "connected", null, "you"),
  app("a1", "Linear", "connected", null),
  app("a6", "Acme Wiki", "needs_sign_in", "connect"),
  app("a2", "Notion", "needs_sign_in", "connect"),
  app("c3", "Slack", "needs_sign_in", "connect"),
  app("a3", "Salesforce", "not_connected", "ask_admin"),
  app("a4", "GitHub", "needs_attention", "connect"),
  app("a5", "Jira", "needs_attention", "ask_admin"),
]

/** Side chats for `?chatlist=1`, deliberately unsorted: the list orders them by latest activity. */
const fixtureSideChats = () => {
  const now = Date.now()
  return [
    { id: "casualgreeting01", title: "Casual greeting", updatedAt: now - 2 * 86_400_000 },
    { id: "officeplan000001", title: "Office plan", updatedAt: now - 5 * 60_000 },
    { id: "weeklyreview0001", title: "Weekly review", updatedAt: now - 3 * 3_600_000 },
  ]
}

const FOLDER = "application/vnd.google-apps.folder"
const day = 86_400_000
const driveEntry = (id: string, name: string, mimeType: string, ageDays: number, size: string | null, parent = "root", text?: string) => ({
  id, name, mimeType, parent, text, size,
  modifiedTime: new Date(Date.UTC(2026, 10, 8, 15) - ageDays * day).toISOString(),
  webViewLink: `https://drive.google.com/file/d/${id}/view`,
})
const fixtureDrive = [
  driveEntry("folderclients01", "Clients", FOLDER, 3, null),
  driveEntry("projectbrief001", "Project brief.txt", "text/plain", 0.1, "1240", "root",
    "Project brief: new office\n\nGoal\nMove the team into the new office by March 1 without losing a working day.\n\nWhat we need\n- Desks and chairs for 14 people\n- Two meeting rooms with screens\n- Fast Wi-Fi on day one\n\nOpen questions\n- Who signs the lease addendum?\n- Do we keep the old phone line?\n\nNext step\nSam sends the floor plan to the landlord on Monday."),
  driveEntry("budget2027sheet", "Budget 2027", "application/vnd.google-apps.spreadsheet", 1, null),
  driveEntry("weeklynotes0001", "Weekly notes", "application/vnd.google-apps.document", 2, null),
  driveEntry("offerletter0001", "Offer letter - Alex.pdf", "application/pdf", 4, "88214"),
  driveEntry("acmecontract001", "Acme contract.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 3, "45210", "folderclients01"),
]

const entry = fileURLToPath(new URL("./chat-screen.tsx", import.meta.url))
const vite = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  // A proof measures one loaded product revision, not a React Fast Refresh remount
  // when another contributor saves source while its nine-second task is running.
  server: { port: Number(process.argv[2] ?? 3091), strictPort: true, ...(process.env.WORKBOT_FIXTURE_FROZEN === "1" ? { hmr: false, watch: null } : {}) },
  plugins: [{
    name: "workbot-chat-screen-fixture",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/"
        if (url === "/fixture/browser-witness") { json(response, 200, browserRequests); return }
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
    frame(1, Buffer.from(JSON.stringify({ type: "page", id: "fixture", title: process.env.WORKBOT_FIXTURE_FRAME_TITLE ?? "Example Domain", url: process.env.WORKBOT_FIXTURE_FRAME_URL ?? "https://example.com" })))
    frame(2, bytes)
  }).catch(() => socket.destroy())
})
await vite.listen()
console.log(vite.resolvedUrls?.local[0])
