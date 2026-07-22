import type { Context } from "hono"
import { routePath } from "hono/route"

export function normalizedHonoRoute(c: Context) {
  const route = routePath(c)
  return route && route !== "/*" ? route : "unmatched"
}
