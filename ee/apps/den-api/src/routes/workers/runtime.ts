import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { WorkerRouteVariables } from "./shared.js"
import { fetchWorkerRuntimeJson, getWorkerByIdForOrg, parseWorkerIdParam, workerIdParamSchema } from "./shared.js"

const workerRuntimeResponseSchema = z.object({}).passthrough().meta({ ref: "WorkerRuntimeResponse" })

export function registerWorkerRuntimeRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workers/:id/runtime",
    describeRoute({
      tags: ["Workers", "Worker Runtime"],
      summary: "Get worker runtime status",
      description: "Fetches runtime version and status information from a specific worker's runtime endpoint.",
      responses: {
        200: jsonResponse("Worker runtime information returned successfully.", workerRuntimeResponseSchema),
        400: jsonResponse("The worker runtime path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to read worker runtime information.", unauthorizedSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    paramValidator(workerIdParamSchema),
    async (c) => {
    const orgId = c.get("activeOrganizationId")
    const params = c.req.valid("param")

    if (!orgId) {
      return c.json({ error: "worker_not_found" }, 404)
    }

    let workerId
    try {
      workerId = parseWorkerIdParam(params.id)
    } catch {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const worker = await getWorkerByIdForOrg(workerId, orgId)
    if (!worker) {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const runtime = await fetchWorkerRuntimeJson({
      workerId: worker.id,
      path: "/runtime/versions",
    })

    return new Response(JSON.stringify(runtime.payload), {
      status: runtime.status,
      headers: {
        "Content-Type": "application/json",
      },
    })
    },
  )

  app.post(
    "/v1/workers/:id/runtime/upgrade",
    describeRoute({
      tags: ["Workers", "Worker Runtime"],
      summary: "Upgrade worker runtime",
      description: "Forwards a runtime upgrade request to a specific worker and returns the worker runtime's response.",
      responses: {
        200: jsonResponse("Worker runtime upgrade request completed successfully.", workerRuntimeResponseSchema),
        400: jsonResponse("The runtime upgrade request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to upgrade a worker runtime.", unauthorizedSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    paramValidator(workerIdParamSchema),
    jsonValidator(z.object({}).passthrough()),
    async (c) => {
    const orgId = c.get("activeOrganizationId")
    const params = c.req.valid("param")
    const body = c.req.valid("json")

    if (!orgId) {
      return c.json({ error: "worker_not_found" }, 404)
    }

    let workerId
    try {
      workerId = parseWorkerIdParam(params.id)
    } catch {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const worker = await getWorkerByIdForOrg(workerId, orgId)
    if (!worker) {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const runtime = await fetchWorkerRuntimeJson({
      workerId: worker.id,
      path: "/runtime/upgrade",
      method: "POST",
      body,
    })

    return new Response(JSON.stringify(runtime.payload), {
      status: runtime.status,
      headers: {
        "Content-Type": "application/json",
      },
    })
    },
  )
}
