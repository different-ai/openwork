import "./instrumentation.js"
import { Server } from "node:http"
import { serve } from "@hono/node-server"
import { flush } from "@sentry/node"
import app from "./app.js"
import { closeUsageWriteDatabase } from "./db.js"
import { env } from "./env.js"
import { installGracefulShutdown, waitForQueueIdle } from "./shutdown.js"
import { gatewayUsageWrites } from "./usage-write-queue.js"

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`gateway listening on ${info.port}`)
})

if (!(server instanceof Server)) throw new Error("gateway expects an HTTP/1.1 server")

installGracefulShutdown(server, {
  drainTimeoutMs: env.shutdownDrainMs,
  afterDrainTimeoutMs: 4_000,
  async afterDrain() {
    // Settle usage for streams that just finished so billing is not lost.
    await waitForQueueIdle(() => gatewayUsageWrites.state())
    await closeUsageWriteDatabase()
    await flush(2_000)
  },
})
