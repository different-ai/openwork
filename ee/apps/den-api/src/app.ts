import "./load-env.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { cors } from "hono/cors"
import { Hono } from "hono"
import { logger } from "hono/logger"
import type { RequestIdVariables } from "hono/request-id"
import { requestId } from "hono/request-id"
import { env } from "./env.js"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "./middleware/index.js"
import { registerAdminRoutes } from "./routes/admin/index.js"
import { registerAuthRoutes } from "./routes/auth/index.js"
import { registerMeRoutes } from "./routes/me/index.js"
import { registerOrgRoutes } from "./routes/org/index.js"
import { registerWorkerRoutes } from "./routes/workers/index.js"
import type { AuthContextVariables } from "./session.js"
import { sessionMiddleware } from "./session.js"

type AppVariables = RequestIdVariables & AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables> & Partial<MemberTeamsContext>

const app = new Hono<{ Variables: AppVariables }>()

app.use("*", logger())
app.use("*", requestId({
  headerName: "",
  generator: () => createDenTypeId("request"),
}))
app.use("*", async (c, next) => {
  await next()
  c.header("X-Request-Id", c.get("requestId"))
})

if (env.corsOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length", "X-Request-Id"],
      maxAge: 600,
    }),
  )
}

app.use("*", sessionMiddleware)

app.get("/", (c) => {
  return c.redirect("https://openworklabs.com", 302)
})

app.get("/health", (c) => {
  return c.json({ ok: true, service: "den-api" })
})

registerAdminRoutes(app)
registerAuthRoutes(app)
registerMeRoutes(app)
registerOrgRoutes(app)
registerWorkerRoutes(app)

app.notFound((c) => {
  return c.json({ error: "not_found" }, 404)
})

export default app
