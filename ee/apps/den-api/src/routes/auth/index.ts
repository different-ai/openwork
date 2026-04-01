import type { Hono } from "hono"
import { auth } from "../../auth.js"
import type { AuthContextVariables } from "../../session.js"
import { registerDesktopAuthRoutes } from "./desktop-handoff.js"

export function registerAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  registerDesktopAuthRoutes(app)
}
