import type { Hono } from "hono"
import { z } from "zod"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import type { WorkerRouteVariables } from "./shared.js"
import { fetchWorkerRuntimeJson, getWorkerByIdForOrg, parseWorkerIdParam, workerIdParamSchema } from "./shared.js"

export function registerWorkerRuntimeRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get("/v1/workers/:id/runtime", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), async (c) => {
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
  })

  app.post("/v1/workers/:id/runtime/upgrade", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), jsonValidator(z.object({}).passthrough()), async (c) => {
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
  })
}
