import "./load-env.js"
import { cors } from "hono/cors"
import { Hono } from "hono"
import { logger } from "hono/logger"
import { z } from "zod"
import { env } from "./env.js"
import { registerProxyRoutes } from "./proxy.js"
import { registerWebhookRoutes } from "./webhooks.js"

const app = new Hono()

app.use("*", logger())

if (env.corsOrigins.length > 0) {
  app.use("*", cors({
    origin: env.corsOrigins,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Webhook-Signature", "X-Test-Connection"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }))
}

app.get("/health", (c) => c.json({ ok: true, service: "inference" }))

registerProxyRoutes(app)
registerWebhookRoutes(app)

app.onError((error, c) => {
  if (error instanceof z.ZodError) {
    return c.json({ error: "invalid_request", issues: error.issues }, 400)
  }
  console.error(error)
  return c.json({ error: "internal_server_error" }, 500)
})

export default app
