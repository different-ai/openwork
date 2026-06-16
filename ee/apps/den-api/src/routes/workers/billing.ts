import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { authenticatedRoute } from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { WorkerRouteVariables } from "./shared.js"

const workerBillingRetiredSchema = z.object({
  error: z.literal("worker_billing_retired"),
  message: z.string(),
}).meta({ ref: "WorkerBillingRetiredError" })

const workerBillingRetiredResponse = {
  error: "worker_billing_retired" as const,
  message: "Cloud worker billing through Polar is retired. Manage existing subscriptions from the organization billing page.",
}

export function registerWorkerBillingRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workers/billing",
    describeRoute({
      tags: ["Workers"],
      hide: true,
      summary: "Get worker billing status",
      description: "Legacy cloud worker billing is retired.",
      responses: {
        410: jsonResponse("Legacy worker billing is retired.", workerBillingRetiredSchema),
        401: jsonResponse("The caller must be signed in to read billing status.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    async (c) => {
      return c.json(workerBillingRetiredResponse, 410)
    },
  )

  app.post(
    "/v1/workers/billing/subscription",
    describeRoute({
      tags: ["Workers"],
      hide: true,
      summary: "Update worker subscription settings",
      description: "Legacy cloud worker billing is retired.",
      responses: {
        410: jsonResponse("Legacy worker billing is retired.", workerBillingRetiredSchema),
        401: jsonResponse("The caller must be signed in to update billing settings.", unauthorizedSchema),
      },
    }),
    authenticatedRoute(),
    async (c) => {
      return c.json(workerBillingRetiredResponse, 410)
    },
  )
}
