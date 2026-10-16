import { timingSafeEqual } from "node:crypto"
import { Hono, type Context } from "hono"
import { routePath } from "hono/route"
import { z } from "zod"
import { loadConfig, type Config } from "../config.js"
import { createErrorReporter, type ErrorReporter } from "../error-reporting.js"
import { createRuntime, gatewayModelCatalog } from "../runtime.js"
import { Store } from "../store.js"
import { durableObjectSql } from "./sql.js"

/**
 * The runner on celld (or any Durable Objects host): the same HTTP API as the Node server, so callers keep their URL
 * and token. Each request reaches one cell, a single-threaded actor with its own SQLite:
 *
 * - With `x-openwork-headless-owner` (Workbot): the owner's cell, holding all their chats, shared memory and tasks.
 * - Without it (Slack, Automations): the conversation's own cell, by session id. Creating one picks the id here.
 *
 * The owner header comes from an authenticated service caller, never from a browser.
 */
const OWNER_HEADER = "x-openwork-headless-owner"
/** Set only by this router (any caller value is replaced), and checked by the cell against its own id. */
const CELL_HEADER = "x-openwork-headless-cell"
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
/** Where a cell keeps its own name: an alarm has no request to read it from. */
const CELL_NAME_KEY = "cell"
/**
 * How far ahead a cell's alarm is set while it has turns running or waiting to resume: after a crash, the node that
 * takes the cell over wakes it within this, recovery marks its turns interrupted, and the alarm resumes them.
 */
const RESUME_ALARM_MS = 30_000

type Runtime = Awaited<ReturnType<typeof createRuntime>>

export class HeadlessCell {
  private readonly ready: Promise<Runtime>
  /** This cell's name, once a request addressed it by name (and it was stored for alarms). */
  private name: string | null = null

  constructor(private readonly ctx: DurableObjectState, private readonly env: CellEnv) {
    const store = new Store(durableObjectSql(ctx.storage))
    this.ready = ctx.blockConcurrencyWhile(() => createRuntime(configFor(env), store))
  }

  /** The cell's name if it is this cell's: the same check a request gets, for one that names the cell. */
  private isOwnName(name: string) {
    return parseCell(name) !== null && this.ctx.id.equals(this.env.HEADLESS_CELL.idFromName(name))
  }

  async fetch(request: Request) {
    const name = request.headers.get(CELL_HEADER) ?? ""
    const cell = parseCell(name)
    if (!cell || !this.isOwnName(name)) return json({ error: "invalid_cell" }, 400)
    if (this.name !== name) {
      await this.ctx.storage.put(CELL_NAME_KEY, name)
      this.name = name
    }
    const url = new URL(request.url)
    const sessionId = SESSION_PATH.exec(url.pathname)?.[1]

    if (cell.kind === "service" && url.pathname !== "/v1/files/status") return json({ error: "not_found" }, 404)
    // A conversation's own cell holds that conversation only.
    if (cell.kind === "session" && sessionId !== cell.sessionId) return json({ error: "unknown_session" }, 404)
    if (cell.kind === "owner") {
      // Nothing in a body or query can put a chat under, or list, another owner.
      if (request.method === "GET" && url.pathname === "/v1/sessions" && url.searchParams.get("owner") !== cell.owner) {
        return json({ error: "owner_mismatch" }, 400)
      }
      if ((request.method === "POST" && url.pathname === "/v1/sessions") || (request.method === "PUT" && sessionId && url.pathname === `/v1/sessions/${sessionId}`)) {
        const body: unknown = await request.clone().json().catch(() => null)
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_request" }, 400)
        if ("owner" in body && body.owner !== cell.owner) return json({ error: "owner_mismatch" }, 400)
        const headers = new Headers(request.headers)
        headers.delete("content-length")
        request = new Request(request, { headers, body: JSON.stringify({ ...body, owner: cell.owner }) })
      }
    }
    const runtime = await this.ready
    const response = await runtime.app.fetch(request)
    if (request.method === "POST" && url.pathname.endsWith("/turns") && response.status === 202) {
      // The caller may stop listening after admission; keep the turn running on either host.
      this.ctx.waitUntil(runtime.runner.idle())
    }
    // A turn admitted or resumed, or turns found interrupted when this cell woke up: keep an alarm set for them.
    await this.armResume(runtime, false)
    // Deleting a chat removes only its rows; the owner's other chats and memory stay.
    return response
  }

  /**
   * Resumes this cell's interrupted turns that have a resume grant, with no request: after a crash or a deploy the
   * alarm wakes the cell (startup recovery marks its turns interrupted), and this resumes them and keeps them running.
   */
  async alarm() {
    const name = await this.ctx.storage.get(CELL_NAME_KEY)
    // A cell only arms alarms after a request named it; anything else is not this cell's to act on.
    if (typeof name !== "string" || !this.isOwnName(name)) return
    this.name = name
    const runtime = await this.ready
    if (!runtime.selfResume) return
    await runtime.selfResume.sweep()
    this.ctx.waitUntil(runtime.runner.idle())
    await this.armResume(runtime, true)
  }

  /** Sets the alarm while any turn is queued, running or waiting to resume; `replace` even if one is set. */
  private async armResume(runtime: Runtime, replace: boolean) {
    const due = runtime.selfResume?.nextSweepAt()
    if (due === null || due === undefined) return
    const at = Math.max(due, Date.now() + RESUME_ALARM_MS)
    const current = replace ? null : await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }
}

function forward(env: CellEnv, request: Request, cell: Cell, init: { method?: string; url?: string } = {}) {
  const name = cellName(cell)
  const headers = new Headers(request.headers)
  headers.set(CELL_HEADER, name)
  const forwarded = new Request(init.url ?? request.url, { method: init.method ?? request.method, headers, body: request.body })
  return env.HEADLESS_CELL.get(env.HEADLESS_CELL.idFromName(name)).fetch(forwarded)
}

const router = new Hono<{ Bindings: CellEnv }>()
router.get("/health", (c) => c.json({ ok: true }))
router.use("/v1/*", async (c, next) => {
  const expected = Buffer.from(configFor(c.env).apiToken)
  const actual = Buffer.from(/^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401)
  await next()
})
const reporters = new WeakMap<Config, ErrorReporter>()
/** Reports a router failure (the route and error type, never the request); a no-op without HEADLESS_SENTRY_DSN. */
function reportRouterError(c: Context<{ Bindings: CellEnv }>, error: Error) {
  let config: Config
  try {
    config = configFor(c.env)
  } catch {
    // The configuration itself is what failed: there is nowhere configured to report to.
    return
  }
  let reporter = reporters.get(config)
  if (!reporter) {
    reporter = createErrorReporter(config.errorReporting)
    reporters.set(config, reporter)
  }
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
// Conversations only leave cells: they are imported into a Node runner (README: Move conversations to Node).
router.post("/v1/sessions/:id/import", (c) => c.json({ error: "import_not_supported" }, 405))
router.all("/v1/*", (c) => {
  const rawOwner = c.req.header(OWNER_HEADER)
  if (rawOwner !== undefined) {
    const owner = ownerSchema.safeParse(rawOwner)
    if (!owner.success) return c.json({ error: "invalid_owner" }, 400)
    return forward(c.env, c.req.raw, { kind: "owner", owner: owner.data })
  }
  const path = new URL(c.req.url).pathname
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
