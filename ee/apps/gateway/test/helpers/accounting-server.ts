// Isolated HTTP boundary for the accounting journey. Real MySQL repository and
// production retention route; only the before-delete fault/barrier is injected.
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createDenDb } from "@openwork-ee/den-db"
import { createDbRollupRepository, registerRollupRoutes, runRollups } from "../../src/rollups.js"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("Scratch database required")
const url = new URL(databaseUrl)
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.startsWith("/openwork_eval_")) {
  throw new Error("Only an isolated local openwork_eval database is allowed")
}
const { db } = createDenDb({ databaseUrl, mode: "mysql" })
const repository = createDbRollupRepository(db)
let fail = false
let hold = false
let reached = false
let release: (() => void) | null = null
const app = new Hono()
app.get("/ready", (c) => c.json({ ready: true }))
app.post("/test/fault", async (c) => {
  const body: unknown = await c.req.json()
  fail = typeof body === "object" && body !== null && "fail" in body && body.fail === true
  hold = typeof body === "object" && body !== null && "hold" in body && body.hold === true
  reached = false
  return c.json({ configured: true })
})
app.get("/test/barrier", (c) => c.json({ reached }))
app.post("/test/release", (c) => { release?.(); return c.json({ released: true }) })
app.onError((error, c) => {
  console.error(error)
  return c.json({ error: "injected_or_database_failure" }, 500)
})
registerRollupRoutes(app, {
  adminToken: "accounting-test-only",
  runRollups: (input) => runRollups({ ...input, repository: {
    ...repository,
    transaction: (run) => repository.transaction((store) => run({
      ...store,
      async deleteRawIds(ids) {
        reached = true
        if (hold) {
          hold = false
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Barrier timeout")), 15_000)
            release = () => { clearTimeout(timer); release = null; resolve() }
          })
        }
        if (fail) { fail = false; throw new Error("Injected before source consumption") }
        return store.deleteRawIds(ids)
      },
    })),
  } }),
})
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) })
