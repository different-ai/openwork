import type { Hono } from "hono"
import type { OrganizationContextVariables } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { registerMemoryCoreRoutes } from "./core.js"

export function registerMemoryRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(
  app: Hono<T>,
) {
  registerMemoryCoreRoutes(app)
}
