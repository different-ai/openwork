import type { Hono } from "hono"
import { registerFreeInferenceRoutes } from "../../free-inference/public.js"
import { registerOpenWorkModelsManagedProviderSource, registerOpenWorkModelsRoutes } from "../../openwork-models/public.js"
import type { OrgRouteVariables } from "./shared.js"

/** Mounts free inference, then OpenWork Models, keeping today's route and OpenAPI order. */
export function registerOrgInferenceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  registerOpenWorkModelsManagedProviderSource()
  registerFreeInferenceRoutes(app)
  registerOpenWorkModelsRoutes(app)
}
