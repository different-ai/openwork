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
import { cellIdsResponse } from "../cell-ids.js"
import { computerDetailResponse, computerFleetResponse } from "../computer-fleet.js"
import { durableObjectSql } from "./sql.js"
import { CELL_UNAVAILABLE, CELL_UNAVAILABLE_RETRY_SECONDS, cellRouteFailure, type CellRouteFailure } from "./route-failure.js"

const OWNER_HEADER = "x-openwork-headless-owner"
const CELL_HEADER = "x-openwork-headless-cell"
const FROM_HEADER = "x-openwork-headless-from"
const INTERNAL_HEADER = "x-openwork-headless-internal"
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

function internalProof(apiToken: string, from: string, to: string) {
  return createHmac("sha256", apiToken).update(`openwork-headless-cell-call\n${from}\n${to}`).digest("hex")
}
function sameSecret(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const CELL_NAME_KEY = "cell"
const RESUME_ALARM_MS = 30_000

type Runtime = Awaited<ReturnType<typeof createRuntime>>
const SOCKET_PING = "ping"
const SOCKET_PONG = "pong"

function closeSocket(socket: WebSocket, code: number) {
  try {
    socket.close(code >= 3000 && code <= 4999 ? code : 1000)
  } catch {
  }
}

export class HeadlessCell {
  private readonly ready: Promise<Runtime>
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
      runtime.background.register(this.sessionCells.directoryJob())
      runtime.background.register(this.sessionCells.splitJob())
      return this.withEventSockets(runtime)
    })
  }

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

  private moved(sessionId: string) {
    for (const socket of this.ctx.getWebSockets(sessionId)) closeSocket(socket, 1012)
    this.ctx.waitUntil(this.ready.then((runtime) => runtime.events.end(sessionId)))
  }

  private forwardTo(cell: string, request: Request) {
    const headers = new Headers(request.headers)
    headers.set(CELL_HEADER, cell)
    headers.delete(FROM_HEADER)
    headers.delete(INTERNAL_HEADER)
    return this.env.HEADLESS_CELL.get(this.env.HEADLESS_CELL.idFromName(cell)).fetch(
      new Request(request.url, { method: request.method, headers, body: request.body }),
    )
  }

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

  private withEventSockets(runtime: Runtime) {
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
          }
        }
      },
    })
    return runtime
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === SOCKET_PING) socket.send(SOCKET_PONG)
  }

  webSocketClose(socket: WebSocket, code: number) {
    closeSocket(socket, code)
  }

  webSocketError(socket: WebSocket) {
    closeSocket(socket, 1000)
  }

  private isOwnName(name: string) {
    return parseCell(name) !== null && this.ctx.id.equals(this.env.HEADLESS_CELL.idFromName(name))
  }

  async fetch(request: Request) {
    try {
      return await this.serve(request)
    } finally {
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
    if (url.pathname.startsWith("/internal/")) return this.internal(request, url.pathname)
    const sessionId = SESSION_PATH.exec(url.pathname)?.[1]
    const creating = request.method === "PUT" && sessionId !== undefined && url.pathname === `/v1/sessions/${sessionId}`

    if (cell.kind === "service" && url.pathname !== "/v1/files/status") return json({ error: "not_found" }, 404)
    if (cell.kind === "session" && sessionId !== cell.sessionId) return json({ error: "unknown_session" }, 404)
    let owned: string | null = null
    if (cell.kind === "session") {
      await this.ready
      const stored = this.cells.cellOwner()
      if (stored !== null || SESSION_CELL_ID.test(cell.sessionId)) {
        const header = request.headers.get(OWNER_HEADER)
        if (header === null) return stored === null ? json({ error: "owner_required" }, 400) : json({ error: "unknown_session" }, 404)
        const owner = ownerSchema.safeParse(header)
        if (!owner.success) return json({ error: "invalid_owner" }, 400)
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
        const split = this.sessionCells.startSplit()
        await this.armResume(runtime, false)
        return json({ split }, 200)
      }
      if (sessionId) {
        const moved = this.cells.forwardOf(sessionId)
        if (moved && moved.owner === cell.owner) return this.forwardTo(moved.cell, request)
        if (SESSION_CELL_ID.test(sessionId) && !this.store.getSession(sessionId)) return this.forwardTo(sessionCellName(sessionId), request)
      }
    }
    const runtime = await this.ready
    const response = await runtime.app.fetch(request)
    if (request.method === "POST" && url.pathname.endsWith("/turns") && response.status === 202) {
      this.ctx.waitUntil(runtime.runner.idle())
    }
    if (owned !== null && request.method !== "GET") {
      if ((creating && response.status === 201) || (request.method === "DELETE" && response.ok)) await this.sessionCells.syncDirectory()
      else this.ctx.waitUntil(runtime.runner.idle().then(() => this.sessionCells.syncDirectory()).then(() => this.armResume(runtime, false)))
    }
    await this.armResume(runtime, false)
    return response
  }

  async alarm() {
    const name = await this.ctx.storage.get(CELL_NAME_KEY)
    if (typeof name !== "string" || !this.isOwnName(name)) return
    this.name = name
    const runtime = await this.ready
    await runtime.runner.runDueSteps()
    this.sessionCells.refreshDirectory()
    if (runtime.selfResume) await runtime.selfResume.sweep()
    await runtime.background.runDue()
    this.ctx.waitUntil(runtime.runner.idle())
    await this.armResume(runtime, true)
  }

  private stepHost(): StepHost {
    return {
      stepAlarm: true,
      wake: () => this.ctx.waitUntil(Promise.resolve().then(() => this.ready).then((runtime) => this.armResume(runtime, false))),
    }
  }

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
  headers.delete(FROM_HEADER)
  headers.delete(INTERNAL_HEADER)
  const forwarded = new Request(init.url ?? request.url, { method: init.method ?? request.method, headers, body: request.body })
  return env.HEADLESS_CELL.get(env.HEADLESS_CELL.idFromName(name)).fetch(forwarded)
}

const router = new Hono<{ Bindings: CellEnv }>()
router.use("*", async (c, next) => {
  await next()
  if (c.res.status !== 101) c.header("X-Robots-Tag", "noindex, nofollow, noarchive")
})
router.get("/health", (c) => c.json({ ok: true }))
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
function reportRouterError(c: Context<{ Bindings: CellEnv }>, error: Error, unavailable: CellRouteFailure | null = null) {
  let config: Config
  try {
    config = configFor(c.env)
  } catch {
    return
  }
  const reporter = reporterFor(config)
  if (!reporter.enabled) return
  const sent = unavailable
    ? reporter.report({ code: CELL_UNAVAILABLE, kind: `${CELL_UNAVAILABLE}:${unavailable.reason}`, level: "warning", tags: { reason: unavailable.reason, route: routePath(c), method: c.req.method } })
    : reporter.report({ code: "request_failed", tags: { route: routePath(c), method: c.req.method }, error })
  try {
    c.executionCtx.waitUntil(sent)
  } catch {
  }
}
router.onError((error, c) => {
  const unavailable = cellRouteFailure(error)
  if (unavailable) {
    console.warn("[headless-cells] cell unavailable", { path: c.req.path, reason: unavailable.reason })
    reportRouterError(c, error, unavailable)
    return c.json({ error: CELL_UNAVAILABLE, reason: unavailable.reason }, 503, { "Retry-After": String(CELL_UNAVAILABLE_RETRY_SECONDS), "Cache-Control": "no-store" })
  }
  console.error("[headless-cells] request failed", { path: c.req.path, error: error.message })
  reportRouterError(c, error)
  return c.json({ error: "internal_error" }, 500)
})
router.get("/v1/health", (c) => serviceHealthResponse(c.req.raw, configFor(c.env)))
router.get("/v1/computers", (c) => computerFleetResponse(configFor(c.env), { fetch: (url, init) => fetch(url, init) }))
router.get("/v1/computers/:source/:id", (c) => computerDetailResponse(configFor(c.env), { fetch: (url, init) => fetch(url, init) }, c.req.param("source"), c.req.param("id")))
router.post("/v1/cells/ids", (c) => cellIdsResponse(c.req.raw, { valid: (name) => parseCell(name) !== null, id: (name) => c.env.HEADLESS_CELL.idFromName(name).toString() }))
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
router.post("/v1/sessions/:id/import", (c) => c.json({ error: "import_not_supported" }, 405))
router.all("/v1/*", (c) => {
  const rawOwner = c.req.header(OWNER_HEADER)
  const path = new URL(c.req.url).pathname
  const pathSession = SESSION_PATH.exec(path)?.[1]
  if (rawOwner !== undefined) {
    const owner = ownerSchema.safeParse(rawOwner)
    if (!owner.success) return c.json({ error: "invalid_owner" }, 400)
    if (pathSession && SESSION_CELL_ID.test(pathSession)) return forward(c.env, c.req.raw, { kind: "session", sessionId: pathSession })
    return forward(c.env, c.req.raw, { kind: "owner", owner: owner.data })
  }
  if ((pathSession && SESSION_CELL_ID.test(pathSession)) || path.startsWith("/v1/owner/")) return c.json({ error: "owner_required" }, 400)
  if (c.req.method === "POST" && path === "/v1/sessions") {
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
