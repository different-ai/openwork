import { deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import type { Handler, MiddlewareHandler } from "hono"
import { z } from "zod"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../openapi.js"
import { currentDeploymentServices, deploymentServicesSnapshot, refreshDeploymentServices } from "../service-readiness-runtime.js"

const unavailableSchema = z.object({ error: z.literal("service_readiness_unavailable") })

/** Diagnostics are per replica and per moment: never cached by browsers or proxies. */
export const deploymentServicesNoStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
}

export const deploymentServicesErrors = {
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Deployment operator access required.", forbiddenSchema),
  503: jsonResponse("Diagnostic admission is unavailable; no upstream detail is exposed.", unavailableSchema),
}

export const deploymentServicesReadResponses = {
  200: jsonResponse("Cached deployment readiness.", deploymentServiceReadinessSchema), ...deploymentServicesErrors,
}
export const deploymentServicesCheckResponses = {
  202: jsonResponse("Check queued, already in progress, or completed recently with matching configuration.", deploymentServiceReadinessSchema),
  429: jsonResponse("No recent matching snapshot is available and another replica recently admitted a check; Retry-After indicates the admission window.", deploymentServiceReadinessSchema),
  ...deploymentServicesErrors,
}

// Every entry point uses the runtime's single controller, including
// stale-while-revalidate, coalescing and durable deployment admission.
export const readDeploymentServices: Handler = (c) => c.json(deploymentServicesSnapshot())

export const checkDeploymentServices: Handler = async (c) => {
  try {
    const retryAfter = await refreshDeploymentServices()
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter))
      return c.json(currentDeploymentServices(), 429)
    }
    return c.json(currentDeploymentServices(), 202)
  } catch {
    // Durable limiter errors may include database destinations.
    return c.json({ error: "service_readiness_unavailable" }, 503)
  }
}
