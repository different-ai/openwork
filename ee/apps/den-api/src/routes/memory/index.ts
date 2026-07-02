import type { Hono } from "hono"
import type { AuthContextVariables } from "../../session.js"
import { registerMemoryCoreRoutes } from "./core.js"

export function registerMemoryRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  registerMemoryCoreRoutes(app)
}
