import { serve } from "@hono/node-server"
import app from "./app.js"
import { env } from "./env.js"

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`worker proxy listening on ${info.port}`)
})
