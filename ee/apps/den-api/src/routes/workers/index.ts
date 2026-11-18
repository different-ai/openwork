import type { Hono } from "hono"
import type { WorkerRouteVariables } from "./shared.js"
import { registerWorkerActivityRoutes } from "./activity.js"
import { registerWorkerCoreRoutes } from "./core.js"

export function registerWorkerRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  registerWorkerActivityRoutes(app)
  registerWorkerCoreRoutes(app)
}
