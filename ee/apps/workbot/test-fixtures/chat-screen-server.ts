import type { IncomingMessage, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { scenarios, type FixtureThread, type FixtureTurn } from "./chat-screen-scenarios.js"

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
  if (path === "/v1/workbot/files") return json(response, 200, { enabled: true, files: [...files.values()].map(({ bytes: _bytes, ...rest }) => rest) })
  if (path === "/v1/workbot/stop" || path.endsWith("/stop")) return json(response, 200, { ok: true })
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
await vite.listen()
console.log(vite.resolvedUrls?.local[0])
