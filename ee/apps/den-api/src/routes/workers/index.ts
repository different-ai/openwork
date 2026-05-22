import type { Hono } from "hono"
import type { WorkerRouteVariables } from "./shared.js"
import { registerWorkerActivityRoutes } from "./activity.js"
import { registerWorkerBillingRoutes } from "./billing.js"
import { registerWorkerCoreRoutes } from "./core.js"
import { registerManagedProviderSyncRoutes } from "./managed-providers.js"
import { registerWorkerRuntimeRoutes } from "./runtime.js"

export function registerWorkerRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  registerWorkerActivityRoutes(app)
  registerWorkerBillingRoutes(app)
  registerWorkerCoreRoutes(app)
  registerManagedProviderSyncRoutes(app as unknown as Hono<{ Variables: WorkerRouteVariables }>)
  registerWorkerRuntimeRoutes(app)
}
