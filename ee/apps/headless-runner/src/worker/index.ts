import "./http.js"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Hono, type Context } from "hono"
import { routePath } from "hono/route"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { loadConfig, type Config } from "../config.js"
import { createErrorReporter, type ErrorReporter } from "../error-reporting.js"
import { READY_MESSAGE } from "../events.js"
import { scopedCatalogResponse } from "../model-catalog.js"
import { createRuntime, gatewayModelCatalog, type StepHost } from "../runtime.js"
import { createModelProbe, modelProbeResponse, type ModelProbe } from "../model-probe.js"
import { Store } from "../store.js"
import { CellsStore } from "../cells-store.js"
import { CellCallError, INTERNAL_PATHS, SESSION_CELL_ID, SessionCells, sessionCellName, type CellIdentity, type InternalPath } from "../cells.js"
import { localMemory } from "../memory.js"
import { serviceHealthResponse } from "../service-health.js"
import { durableObjectSql } from "./sql.js"

/**
 * The runner on celld (or any Durable Objects host): the same HTTP API as the Node server, so callers keep their URL
 * and token. Each request reaches one cell, a single-threaded actor with its own SQLite:
 *
 * - With `x-openwork-headless-owner` (Workbot): the owner's cell, holding their legacy chats, the directory of their
 *   chats in session cells, and their shared memory. A session id `hs_c_<32 hex>` goes to its own session cell
 *   (`session:<id>`), which stores its owner at creation and answers only that owner (OWNER-CELLS.md, "Session cells").
 * - Without it (Slack, Automations): the conversation's own cell, by session id. Creating one picks the id here.
 *
 * The owner header comes from an authenticated service caller, never from a browser. Cells also call each other
 * (`/internal/*`, see cells.ts): only from a cell, never through this router.
 */
const OWNER_HEADER = "x-openwork-headless-owner"
/** Set only by this router (any caller value is replaced), and checked by the cell against its own id. */
const CELL_HEADER = "x-openwork-headless-cell"
/** On a cell-to-cell call: the calling cell's name, and an HMAC binding it to the called cell (see internalProof). */
const FROM_HEADER = "x-openwork-headless-from"
const INTERNAL_HEADER = "x-openwork-headless-internal"
/** Test only: waits this long between a split's import calls, so the e2e can kill the runtime mid-split. */
const SPLIT_PAUSE_VAR = "HEADLESS_TEST_SPLIT_PAUSE_MS"
export type CellEnv = { HEADLESS_CELL: DurableObjectNamespace; [key: string]: unknown }
const ownerSchema = z.string().min(1).max(200)
const SESSION_ID = /^hs_[A-Za-z0-9_-]{8,96}$/
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)(?:\/|$)/
const configCache = new WeakMap<object, Config>()

function configFor(env: CellEnv) {
  const existing = configCache.get(env)
  if (existing) return existing
  const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  const config = loadConfig(vars)
  if (config.files.kind !== "off" && config.files.kind !== "s3") throw new Error("cells_require_s3_files")
  configCache.set(env, config)
  return config
}

type Cell = { kind: "owner"; owner: string } | { kind: "session"; sessionId: string } | { kind: "service" }
const cellName = (cell: Cell) => (cell.kind === "owner" ? `owner:${cell.owner}` : cell.kind === "session" ? `session:${cell.sessionId}` : "service")
function parseCell(name: string): Cell | null {
  if (name === "service") return { kind: "service" }
  if (name.startsWith("owner:")) {
    const owner = ownerSchema.safeParse(name.slice("owner:".length))
    return owner.success ? { kind: "owner", owner: owner.data } : null
  }
  if (name.startsWith("session:") && SESSION_ID.test(name.slice("session:".length))) return { kind: "session", sessionId: name.slice("session:".length) }
  return null
}

const json = (body: unknown, status: number) => Response.json(body, { status })

/**
 * Proves a cell-to-cell call came from cell `from` to cell `to`: an HMAC with the service token. Requests only reach a
 * cell from this Worker's own code (the router sets the cell header and never forwards `/internal/*`), so this is
 * defense in depth against a public request being treated as a cell's.
 */
function internalProof(apiToken: string, from: string, to: string) {
  return createHmac("sha256", apiToken).update(`openwork-headless-cell-call\n${from}\n${to}`).digest("hex")
}
function sameSecret(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Where a cell keeps its own name: an alarm has no request to read it from. */
const CELL_NAME_KEY = "cell"
/**
 * How far ahead a cell's alarm is set while it has turns running or waiting to resume: after a crash, the node that
 * takes the cell over wakes it within this, recovery marks its turns interrupted, and the alarm resumes them.
 */
const RESUME_ALARM_MS = 30_000

type Runtime = Awaited<ReturnType<typeof createRuntime>>
/** A live-event socket's keep-alive and its answer (headless-protocol's `openEventsSocket` sends it). */
const SOCKET_PING = "ping"
const SOCKET_PONG = "pong"

/** Completes a live-event socket's close; a code an application may not send back is answered as a normal close. */
function closeSocket(socket: WebSocket, code: number) {
  try {
    socket.close(code >= 3000 && code <= 4999 ? code : 1000)
  } catch {
    // Already closed.
  }
}

export class HeadlessCell {
  private readonly ready: Promise<Runtime>
  /** This cell's name, once a request addressed it by name (and it was stored for alarms). */
  private name: string | null = null
  private readonly store: Store
  private readonly cells: CellsStore
  private readonly sessionCells: SessionCells

  constructor(private readonly ctx: DurableObjectState, private readonly env: CellEnv) {
    const store = new Store(durableObjectSql(ctx.storage))
    this.store = store
    this.cells = CellsStore.of(store)
    const pause = Number(typeof env[SPLIT_PAUSE_VAR] === "string" ? env[SPLIT_PAUSE_VAR] : 0)
    this.sessionCells = new SessionCells({
      store,
      cells: this.cells,
      self: (): CellIdentity | null => (this.name === null ? null : parseCell(this.name)),
      call: (cell, path, body) => this.callCell(cell, path, body),
      moved: (sessionId) => this.moved(sessionId),
      imported: () => this.ctx.waitUntil(this.ready.then((runtime) => this.armResume(runtime, false))),
      handedOver: () => this.ctx.waitUntil(this.ready.then((runtime) => runtime.storage.deletionsChanged())),
      report: (code, error) => {
        const reporter = reporterFor(configFor(env))
        if (reporter.enabled) this.ctx.waitUntil(reporter.report({ code, error }))
      },
      ...(Number.isFinite(pause) && pause > 0 ? { pauseMs: pause } : {}),
    })
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const runtime = await createRuntime(configFor(env), store, this.stepHost(), {
        memory: this.sessionCells.memoryResolver(localMemory(store, this.cells)),
        cells: this.cells,
        indexHeld: () => this.cells.meta("index_hold") !== null,
      })
      // Session cells: the directory outbox (session cell) and the owner-cell split (owner cell); each acts only there.
      runtime.background.register(this.sessionCells.directoryJob())
      runtime.background.register(this.sessionCells.splitJob())
      return this.withEventSockets(runtime)
    })
  }

  /** Another cell's internal route: JSON in and out, the calling cell named and proven (see internalProof). */
  private async callCell(cell: string, path: InternalPath, body: unknown): Promise<unknown> {
    const from = this.name
    if (from === null) throw new CellCallError(400, "invalid_cell")
    const headers = new Headers({ "content-type": "application/json" })
    headers.set(CELL_HEADER, cell)
    headers.set(FROM_HEADER, from)
    headers.set(INTERNAL_HEADER, internalProof(configFor(this.env).apiToken, from, cell))
    const response = await this.env.HEADLESS_CELL.get(this.env.HEADLESS_CELL.idFromName(cell)).fetch(
      new Request(`https://cell${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    )
    const answer: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = answer && typeof answer === "object" && "error" in answer && typeof answer.error === "string" ? answer.error : "unknown"
      throw new CellCallError(response.status, code)
    }
    return answer
  }

  /** A chat moved out of this cell: its live readers here end (sockets close as a restart), so they reconnect. */
  private moved(sessionId: string) {
    for (const socket of this.ctx.getWebSockets(sessionId)) closeSocket(socket, 1012)
    this.ctx.waitUntil(this.ready.then((runtime) => runtime.events.end(sessionId)))
  }

  /** Sends a public request on to the cell that now holds its chat; the answer (a WebSocket too) is that cell's. */
  private forwardTo(cell: string, request: Request) {
    const headers = new Headers(request.headers)
    headers.set(CELL_HEADER, cell)
    headers.delete(FROM_HEADER)
    headers.delete(INTERNAL_HEADER)
    return this.env.HEADLESS_CELL.get(this.env.HEADLESS_CELL.idFromName(cell)).fetch(
      new Request(request.url, { method: request.method, headers, body: request.body }),
    )
  }

  /** A call from another cell (`/internal/*`): only with the proof; answered by cells.ts. */
  private async internal(request: Request, path: string) {
    const name = this.name
    const from = request.headers.get(FROM_HEADER) ?? ""
    const proof = request.headers.get(INTERNAL_HEADER) ?? ""
    if (name === null || request.method !== "POST" || !INTERNAL_PATHS.has(path) || !parseCell(from) || !sameSecret(proof, internalProof(configFor(this.env).apiToken, from, name))) {
      return json({ error: "not_found" }, 404)
    }
    const body: unknown = await request.json().catch(() => null)
    const runtime = await this.ready
    const answer = await this.sessionCells.handle(from, path, body)
    await this.armResume(runtime, false)
    return json(answer.body, answer.status)
  }

  /**
   * Live events over hibernatable WebSockets (GET /v1/sessions/:id/events with `Upgrade: websocket`): each socket is
   * tagged with its session id and found again through the cell's state, never an in-memory listener, so it keeps
   * receiving events after the cell sleeps or switches to new code, and it never holds up that switch. Runs at every
   * start of the cell, so events from whatever runs after a wake (a request, the alarm) reach the sockets.
   */
  private withEventSockets(runtime: Runtime) {
    // A client's keep-alive is answered without waking the cell.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_PING, SOCKET_PONG))
    runtime.events.useSockets({
      accept: (sessionId) => {
        const pair = new WebSocketPair()
        this.ctx.acceptWebSocket(pair[1], [sessionId])
        pair[1].send(READY_MESSAGE)
        return new Response(null, { status: 101, webSocket: pair[0] })
      },
      send: (sessionId, data) => {
        for (const socket of this.ctx.getWebSockets(sessionId)) {
          try {
            socket.send(data)
          } catch {
            // A socket closing as this runs; the others still get the event.
          }
        }
      },
    })
    return runtime
  }

  /** Live-event sockets carry nothing from the client but keep-alives (answered by the auto-response first). */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === SOCKET_PING) socket.send(SOCKET_PONG)
  }

  webSocketClose(socket: WebSocket, code: number) {
    closeSocket(socket, code)
  }

  webSocketError(socket: WebSocket) {
    closeSocket(socket, 1000)
  }

  /** The cell's name if it is this cell's: the same check a request gets, for one that names the cell. */
  private isOwnName(name: string) {
    return parseCell(name) !== null && this.ctx.id.equals(this.env.HEADLESS_CELL.idFromName(name))
  }

  async fetch(request: Request) {
    try {
      return await this.serve(request)
    } finally {
      // A request answered without reading its body (a refusal, the split route): release it, not after the answer.
      if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => undefined)
    }
  }

  private async serve(request: Request) {
    const name = request.headers.get(CELL_HEADER) ?? ""
    const cell = parseCell(name)
    if (!cell || !this.isOwnName(name)) return json({ error: "invalid_cell" }, 400)
    if (this.name !== name) {
      await this.ctx.storage.put(CELL_NAME_KEY, name)
      this.name = name
    }
    const url = new URL(request.url)
    // Another cell's call: never a public request (the router answers /internal/* with 404).
    if (url.pathname.startsWith("/internal/")) return this.internal(request, url.pathname)
    const sessionId = SESSION_PATH.exec(url.pathname)?.[1]
    const creating = request.method === "PUT" && sessionId !== undefined && url.pathname === `/v1/sessions/${sessionId}`

    if (cell.kind === "service" && url.pathname !== "/v1/files/status") return json({ error: "not_found" }, 404)
    // A conversation's own cell holds that conversation only.
    if (cell.kind === "session" && sessionId !== cell.sessionId) return json({ error: "unknown_session" }, 404)
    // A chat in its own cell under an owner (hs_c_, or a moved legacy chat): only that owner reaches it.
    let owned: string | null = null
    if (cell.kind === "session") {
      await this.ready
      const stored = this.cells.cellOwner()
      if (stored !== null || SESSION_CELL_ID.test(cell.sessionId)) {
        const header = request.headers.get(OWNER_HEADER)
        if (header === null) return stored === null ? json({ error: "owner_required" }, 400) : json({ error: "unknown_session" }, 404)
        const owner = ownerSchema.safeParse(header)
        if (!owner.success) return json({ error: "invalid_owner" }, 400)
        // Claimed by the request that creates the chat; any other owner gets what an unknown chat gets.
        if (stored !== null ? stored !== owner.data : creating && this.cells.claimCellOwner(owner.data) !== owner.data) return json({ error: "unknown_session" }, 404)
        if (stored === null && !creating) return json({ error: "unknown_session" }, 404)
        owned = owner.data
        if (creating) {
          const rewritten = await withOwner(request, owned)
          if (rewritten instanceof Response) return rewritten
          request = rewritten
        }
        this.sessionCells.markLive()
      }
    }
    if (cell.kind === "owner") {
      // Nothing in a body or query can put a chat under, or list, another owner.
      if (request.method === "GET" && url.pathname === "/v1/sessions" && url.searchParams.get("owner") !== cell.owner) {
        return json({ error: "owner_mismatch" }, 400)
      }
      if ((request.method === "POST" && url.pathname === "/v1/sessions") || creating) {
        const rewritten = await withOwner(request, cell.owner)
        if (rewritten instanceof Response) return rewritten
        request = rewritten
      }
      const runtime = await this.ready
      if (request.method === "POST" && url.pathname === "/v1/owner/split") {
        // Moving this owner's legacy chats into their own cells: idempotent, done by the owner-split job.
        const split = this.sessionCells.startSplit()
        await this.armResume(runtime, false)
        return json({ split }, 200)
      }
      if (sessionId) {
        // A chat moved to its own cell keeps its id: its requests (a WebSocket too) are answered there. A session-cell
        // id sent here by an older router is too.
        const moved = this.cells.forwardOf(sessionId)
        if (moved && moved.owner === cell.owner) return this.forwardTo(moved.cell, request)
        if (SESSION_CELL_ID.test(sessionId) && !this.store.getSession(sessionId)) return this.forwardTo(sessionCellName(sessionId), request)
      }
    }
    const runtime = await this.ready
    const response = await runtime.app.fetch(request)
    if (request.method === "POST" && url.pathname.endsWith("/turns") && response.status === 202) {
      // The caller may stop listening after admission; keep the turn running on either host.
      this.ctx.waitUntil(runtime.runner.idle())
    }
    if (owned !== null && request.method !== "GET") {
      // The owner's directory hears of this chat: right away when it is created or deleted, otherwise once what the
      // request started has finished (a turn's end, a rename), through the durable outbox.
      if ((creating && response.status === 201) || (request.method === "DELETE" && response.ok)) await this.sessionCells.syncDirectory()
      else this.ctx.waitUntil(runtime.runner.idle().then(() => this.sessionCells.syncDirectory()).then(() => this.armResume(runtime, false)))
    }
    // A turn admitted or resumed, or turns found interrupted when this cell woke up: keep an alarm set for them.
    await this.armResume(runtime, false)
    // Deleting a chat removes only its rows; the owner's other chats and memory stay.
    return response
  }

  /**
   * The cell's one alarm, for two jobs, with no request:
   *
   * - Step-mode turns' due steps (see steps.ts): each runs to completion, lanes in parallel. Between alarms nothing
   *   runs in the cell, so a celld deploy switches it to the new code there instead of cancelling a step.
   * - Self-resume: after a crash or a deploy the alarm wakes the cell (startup recovery marks its turns interrupted),
   *   and this resumes those with a resume grant and keeps them running.
   * - Storage upkeep (background.ts): sealing, the Den index outbox, owner-cell splits.
   *
   * Then it is set again for the earliest of both.
   */
  async alarm() {
    const name = await this.ctx.storage.get(CELL_NAME_KEY)
    // A cell only arms alarms after a request named it; anything else is not this cell's to act on.
    if (typeof name !== "string" || !this.isOwnName(name)) return
    this.name = name
    const runtime = await this.ready
    // Never throws: a step's failure is its turn's alone.
    await runtime.runner.runDueSteps()
    // A step may have ended a turn: a session cell's directory entry follows (sent by the owner-directory job).
    this.sessionCells.refreshDirectory()
    if (runtime.selfResume) await runtime.selfResume.sweep()
    // Storage upkeep (sealing, Den index outbox, owner-cell splits); never throws.
    await runtime.background.runDue()
    // Turns run in one go that started here (resumed, or next in a lane a step-mode turn just gave back) keep running.
    this.ctx.waitUntil(runtime.runner.idle())
    await this.armResume(runtime, true)
  }

  /** What the runner needs from this cell to run step-mode turns from the alarm. */
  private stepHost(): StepHost {
    return {
      stepAlarm: true,
      // After the runtime exists: the runner can call this while it is being built (startup recovery).
      wake: () => this.ctx.waitUntil(Promise.resolve().then(() => this.ready).then((runtime) => this.armResume(runtime, false))),
    }
  }

  /**
   * Sets the alarm for the earliest step due, and while any turn is queued, running or waiting to resume; `replace`
   * even if one is set.
   */
  private async armResume(runtime: Runtime, replace: boolean) {
    const sweep = runtime.selfResume?.nextSweepAt()
    const step = runtime.runner.nextStepAt()
    const upkeep = runtime.background.nextAt()
    const due = [
      ...(sweep === null || sweep === undefined ? [] : [Math.max(sweep, Date.now() + RESUME_ALARM_MS)]),
      ...(step === null ? [] : [step]),
      ...(upkeep === null ? [] : [upkeep]),
    ]
    if (due.length === 0) return
    const at = Math.min(...due)
    const current = replace ? null : await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }
}

/** The request with the body's owner set to `owner`; a body naming another owner is refused. */
async function withOwner(request: Request, owner: string): Promise<Request | Response> {
  const body: unknown = await request.clone().json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_request" }, 400)
  if ("owner" in body && body.owner !== owner) return json({ error: "owner_mismatch" }, 400)
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  return new Request(request, { headers, body: JSON.stringify({ ...body, owner }) })
}

function forward(env: CellEnv, request: Request, cell: Cell, init: { method?: string; url?: string } = {}) {
  const name = cellName(cell)
  const headers = new Headers(request.headers)
  headers.set(CELL_HEADER, name)
  // Only a cell names a calling cell.
  headers.delete(FROM_HEADER)
  headers.delete(INTERNAL_HEADER)
  const forwarded = new Request(init.url ?? request.url, { method: init.method ?? request.method, headers, body: request.body })
  return env.HEADLESS_CELL.get(env.HEADLESS_CELL.idFromName(name)).fetch(forwarded)
}

const router = new Hono<{ Bindings: CellEnv }>()
router.get("/health", (c) => c.json({ ok: true }))
// Cell-to-cell routes are only for cells: never reachable from outside, whatever the request carries.
router.all("/internal/*", (c) => c.json({ error: "not_found" }, 404))
router.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") c.header("Cache-Control", "no-store")
  const expected = Buffer.from(configFor(c.env).apiToken)
  const actual = Buffer.from(/^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401)
  await next()
})
const reporters = new WeakMap<Config, ErrorReporter>()
function reporterFor(config: Config) {
  let reporter = reporters.get(config)
  if (!reporter) {
    reporter = createErrorReporter(config.errorReporting)
    reporters.set(config, reporter)
  }
  return reporter
}
/** Reports a router failure (the route and error type, never the request); a no-op without HEADLESS_SENTRY_DSN. */
function reportRouterError(c: Context<{ Bindings: CellEnv }>, error: Error) {
  let config: Config
  try {
    config = configFor(c.env)
  } catch {
    // The configuration itself is what failed: there is nowhere configured to report to.
    return
  }
  const reporter = reporterFor(config)
  if (!reporter.enabled) return
  const sent = reporter.report({ code: "request_failed", tags: { route: routePath(c), method: c.req.method }, error })
  try {
    c.executionCtx.waitUntil(sent)
  } catch {
    // No execution context (tests): the report still runs on its own.
  }
}
router.onError((error, c) => {
  console.error("[headless-cells] request failed", { path: c.req.path, error: error.message })
  reportRouterError(c, error)
  return c.json({ error: "internal_error" }, 500)
})
// Service-wide configuration facts stay in the router: no owner or conversation cell is touched.
router.get("/v1/health", (c) => serviceHealthResponse(c.req.raw, configFor(c.env)))
const catalogs = new WeakMap<Config, ReturnType<typeof gatewayModelCatalog>>()
router.get("/v1/models", async (c) => {
  const config = configFor(c.env)
  let catalog = catalogs.get(config)
  if (!catalog) {
    catalog = gatewayModelCatalog(config)
    catalogs.set(config, catalog)
  }
  return c.json(await catalog())
})
router.post("/v1/models", bodyLimit({ maxSize: 8192 }), (c) => {
  const config = configFor(c.env)
  let catalog = catalogs.get(config)
  if (!catalog) {
    catalog = gatewayModelCatalog(config)
    catalogs.set(config, catalog)
  }
  return scopedCatalogResponse(c.req.raw, catalog)
})
const modelProbes = new WeakMap<Config, ModelProbe>()
router.post("/v1/model-probe", bodyLimit({ maxSize: 8192 }), (c) => {
  const config = configFor(c.env)
  let probe = modelProbes.get(config)
  if (!probe) {
    probe = createModelProbe(config, (input, init) => fetch(input, init))
    modelProbes.set(config, probe)
  }
  return modelProbeResponse(c.req.raw, probe)
})
// Conversations only leave cells: they are imported into a Node runner (README: Move conversations to Node).
router.post("/v1/sessions/:id/import", (c) => c.json({ error: "import_not_supported" }, 405))
router.all("/v1/*", (c) => {
  const rawOwner = c.req.header(OWNER_HEADER)
  const path = new URL(c.req.url).pathname
  const pathSession = SESSION_PATH.exec(path)?.[1]
  if (rawOwner !== undefined) {
    const owner = ownerSchema.safeParse(rawOwner)
    if (!owner.success) return c.json({ error: "invalid_owner" }, 400)
    // A chat in its own cell (hs_c_): that cell, which checks the owner. Everything else of the owner's: their cell.
    if (pathSession && SESSION_CELL_ID.test(pathSession)) return forward(c.env, c.req.raw, { kind: "session", sessionId: pathSession })
    return forward(c.env, c.req.raw, { kind: "owner", owner: owner.data })
  }
  // Chats in their own cell, and owner-level routes, belong to an owner.
  if ((pathSession && SESSION_CELL_ID.test(pathSession)) || path.startsWith("/v1/owner/")) return c.json({ error: "owner_required" }, 400)
  if (c.req.method === "POST" && path === "/v1/sessions") {
    // A conversation without an owner gets its own cell; its id is chosen here so it can be found again.
    const sessionId = `hs_${crypto.randomUUID().replaceAll("-", "")}`
    return forward(c.env, c.req.raw, { kind: "session", sessionId }, { method: "PUT", url: new URL(`/v1/sessions/${sessionId}`, c.req.url).toString() })
  }
  const sessionId = SESSION_PATH.exec(path)?.[1]
  if (sessionId) {
    if (!SESSION_ID.test(sessionId)) return c.json({ error: "unknown_session" }, 404)
    return forward(c.env, c.req.raw, { kind: "session", sessionId })
  }
  if (path === "/v1/files/status") return forward(c.env, c.req.raw, { kind: "service" })
  if (path === "/v1/sessions") return c.json({ error: "owner_required" }, 400)
  return c.json({ error: "not_found" }, 404)
})
export default router
