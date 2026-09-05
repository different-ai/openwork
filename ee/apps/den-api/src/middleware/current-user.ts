import type { MiddlewareHandler } from "hono"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuthContextVariables } from "../session.js"

export const requireUserMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!c.get("user")?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  await next()
}

export const requireUserSessionMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!c.get("user")?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const session = c.get("session")
  if (c.get("apiKey") || !session?.id || !session.token) {
    return c.json({
      error: "forbidden",
      message: "Use a signed-in user session for this operation.",
    }, 403) as never
  }

  try {
    normalizeDenTypeId("session", session.id)
  } catch {
    return c.json({
      error: "forbidden",
      message: "Use a signed-in user session for this operation.",
    }, 403) as never
  }

  await next()
}
