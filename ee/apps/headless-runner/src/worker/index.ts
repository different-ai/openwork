import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { loadConfig, type Config } from "../config.js"
import { createRuntime, gatewayModelCatalog } from "../runtime.js"
import { Store } from "../store.js"
import { durableObjectSql } from "./sql.js"

/** Experimental service-to-service owner routing; never accept this header from an untrusted browser. */
const OWNER_HEADER = "x-openwork-headless-owner"
export type CellEnv = { HEADLESS_OWNER: DurableObjectNamespace; [key: string]: unknown }
const ownerSchema = z.string().min(1).max(200)
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

/** All an owner's chats, shared memory, tasks, events and cancellations reach one SQLite owner. */
export class HeadlessOwner {
  private readonly ready: ReturnType<typeof createRuntime>
  private readonly store: Store

  constructor(private readonly ctx: DurableObjectState, private readonly env: CellEnv) {
    this.store = new Store(durableObjectSql(ctx.storage))
    this.ready = ctx.blockConcurrencyWhile(() => createRuntime(configFor(env), this.store))
  }

  async fetch(request: Request) {
    const parsed = ownerSchema.safeParse(request.headers.get(OWNER_HEADER))
    if (!parsed.success || !this.ctx.id.equals(this.env.HEADLESS_OWNER.idFromName(parsed.data))) {
      return Response.json({ error: "invalid_owner" }, { status: 400 })
    }
    const owner = parsed.data
    const url = new URL(request.url)
    // A body cannot assign a chat to another owner. The header is supplied by the authenticated service caller.
    if ((request.method === "POST" && url.pathname === "/v1/sessions") ||
        (request.method === "PUT" && /^\/v1\/sessions\/[^/]+$/.test(url.pathname))) {
      const body: unknown = await request.clone().json().catch(() => null)
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid_request" }, { status: 400 })
      if ("owner" in body && body.owner !== owner) return Response.json({ error: "owner_mismatch" }, { status: 400 })
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      request = new Request(request, { headers, body: JSON.stringify({ ...body, owner }) })
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions" && url.searchParams.get("owner") !== owner) {
      return Response.json({ error: "owner_mismatch" }, { status: 400 })
    }
    // No storage.deleteAll(): deleting one side chat must preserve the owner's other chats and memory.
    const runtime = await this.ready
    const response = await runtime.app.fetch(request)
    if (request.method === "POST" && url.pathname.endsWith("/turns") && response.status === 202) {
      // A caller may stop polling after admission. Explicitly keep detached turns alive on either actor host.
      this.ctx.waitUntil(runtime.runner.idle())
    }
    return response
  }
}

const router = new Hono<{ Bindings: CellEnv }>()
router.get("/health", (c) => c.json({ ok: true }))
router.use("/v1/*", async (c, next) => {
  const expected = Buffer.from(configFor(c.env).apiToken)
  const actual = Buffer.from(c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401)
  await next()
})
router.onError((error, c) => {
  console.error("[headless-cells] request failed", { path: c.req.path, error: error.message })
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
router.all("/v1/*", (c) => {
  const owner = ownerSchema.safeParse(c.req.header(OWNER_HEADER))
  if (!owner.success) return c.json({ error: "owner_required" }, 400)
  const id = c.env.HEADLESS_OWNER.idFromName(owner.data)
  return c.env.HEADLESS_OWNER.get(id).fetch(c.req.raw)
})
export default router
