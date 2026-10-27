import { serve } from "@hono/node-server"
import { loadConfig } from "./config.js"
import { Store } from "./store.js"
import { nodeSqlite } from "./node-sqlite.js"
import { createRuntime } from "./runtime.js"

const SELF_RESUME_INTERVAL_MS = 60_000
/** How often the Node host checks for due storage upkeep (see background.ts). */
const BACKGROUND_INTERVAL_MS = 5_000

const config = loadConfig()
const store = new Store(nodeSqlite(config.dbPath))
// Step-mode turns run here too, each step as soon as it is due: there is no deploy switch to wait for on Node.
const { app, runner, recovered, steps, blobKind, computer, selfResume, background } = await createRuntime(config, store)
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[headless-runner] listening on :${info.port} (${recovered} interrupted turn(s) recovered, ${steps.continued} step-mode turn(s) continued, files: ${blobKind}, computer: ${computer ? `${config.computer?.kind} ${computer.image}` : "off"}, self-resume: ${selfResume ? "on" : "off"})`,
  )
})

// Turns with a resume grant keep going on their own: right after startup recovery, then every minute while one waits.
let resumeTimer: ReturnType<typeof setInterval> | undefined
if (selfResume) {
  void selfResume.sweep()
  resumeTimer = setInterval(() => {
    const due = selfResume.nextSweepAt()
    if (due !== null && due <= Date.now()) void selfResume.sweep()
  }, SELF_RESUME_INTERVAL_MS)
  resumeTimer.unref()
}

// Storage upkeep (sealing, the Den index outbox): run whatever is due every few seconds; never throws.
const backgroundTimer = setInterval(() => {
  const due = background.nextAt()
  if (due !== null && due <= Date.now()) void background.runDue()
}, BACKGROUND_INTERVAL_MS)
backgroundTimer.unref()

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[headless-runner] ${signal}: interrupting in-flight turns`)
  server.close()
  clearInterval(resumeTimer)
  clearInterval(backgroundTimer)
  await runner.shutdown()
  store.close()
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))
