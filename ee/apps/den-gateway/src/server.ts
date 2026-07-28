import { serve } from "@hono/node-server"
import app from "./app.js"
import { env } from "./env.js"

serve({ fetch: app.fetch, port: env.port }, (info) => {
  process.stdout.write(JSON.stringify({ service: "den-gateway", message: "server listening", port: info.port }) + "\n")
})
