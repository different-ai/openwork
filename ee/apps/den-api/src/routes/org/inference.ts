import type { Hono } from "hono"
import { registerFreeInferenceRoutes } from "../../free-inference/routes.js"
import { registerOpenWorkModelsManagedProviderSource } from "../../openwork-models/public.js"
import { registerOpenWorkModelsRoutes } from "../../openwork-models/routes.js"
import type { OrgRouteVariables } from "./shared.js"

/**
 * Mounts free inference, then OpenWork Models, keeping today's route and OpenAPI order.
 * Route registrars are imported from each half's `routes.ts`, not `public.ts`: `public.ts` is imported by
 * billing and member hooks, and pulling the HTTP layer in from there creates an import cycle.
 */
export function registerOrgInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOpenWorkModelsManagedProviderSource()
  registerFreeInferenceRoutes(app)
  registerOpenWorkModelsRoutes(app)
}
