import { serve } from "@hono/node-server"
import { loadConfig } from "./config.js"
import { Store } from "./store.js"
import { nodeSqlite } from "./node-sqlite.js"
import { createRuntime } from "./runtime.js"

const config = loadConfig()
const store = new Store(nodeSqlite(config.dbPath))
const { app, runner, recovered, blobKind, computer } = await createRuntime(config, store)
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[headless-runner] listening on :${info.port} (${recovered} interrupted turn(s) recovered, files: ${blobKind}, computer: ${computer ? `${config.computer?.kind} ${computer.image}` : "off"})`,
  )
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[headless-runner] ${signal}: interrupting in-flight turns`)
  server.close()
  await runner.shutdown()
  store.close()
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))
