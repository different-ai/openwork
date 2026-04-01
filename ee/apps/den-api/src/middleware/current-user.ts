import type { MiddlewareHandler } from "hono"
import type { AuthContextVariables } from "../session.js"

export const requireUserMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!c.get("user")?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  await next()
}
