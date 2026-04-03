import { desc, eq } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, queryValidator, requireUserMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import { getOrganizationLimitStatus } from "../../organization-limits.js"
import type { WorkerRouteVariables } from "./shared.js"
import {
  continueCloudProvisioning,
  createWorkerSchema,
  deleteWorkerCascade,
  getLatestWorkerInstance,
  getWorkerByIdForOrg,
  getWorkerTokensAndConnect,
  listWorkersQuerySchema,
  parseWorkerIdParam,
  toInstanceResponse,
  toWorkerResponse,
  token,
  updateWorkerSchema,
  workerIdParamSchema,
} from "./shared.js"

export function registerWorkerCoreRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get("/v1/workers", requireUserMiddleware, resolveUserOrganizationsMiddleware, queryValidator(listWorkersQuerySchema), async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const query = c.req.valid("query")

    if (!orgId) {
      return c.json({ workers: [] })
    }

    const rows = await db
      .select()
      .from(WorkerTable)
      .where(eq(WorkerTable.org_id, orgId))
      .orderBy(desc(WorkerTable.created_at))
      .limit(query.limit)

    const workers = await Promise.all(
      rows.map(async (row) => {
        const instance = await getLatestWorkerInstance(row.id)
        return {
          ...toWorkerResponse(row, user.id),
          instance: toInstanceResponse(instance),
        }
      }),
    )

    return c.json({ workers })
  })

  app.post("/v1/workers", requireUserMiddleware, resolveUserOrganizationsMiddleware, jsonValidator(createWorkerSchema), async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const input = c.req.valid("json")

    if (!orgId) {
      return c.json({ error: "organization_unavailable" }, 400)
    }

    if (input.destination === "local" && !input.workspacePath) {
      return c.json({ error: "workspace_path_required" }, 400)
    }

    if (input.destination === "cloud") {
      const workerLimit = await getOrganizationLimitStatus(orgId, "workers")
      if (workerLimit.exceeded) {
        return c.json({
          error: "org_limit_reached",
          limitType: "workers",
          limit: workerLimit.limit,
          currentCount: workerLimit.currentCount,
          message: `This workspace currently supports up to ${workerLimit.limit} workers. Contact support to increase the limit.`,
        }, 409)
      }
    }

    const workerId = createDenTypeId("worker")
    const workerStatus = input.destination === "cloud" ? "provisioning" : "healthy"

    await db.insert(WorkerTable).values({
      id: workerId,
      org_id: orgId,
      created_by_user_id: user.id,
      name: input.name,
      description: input.description,
      destination: input.destination,
      status: workerStatus,
      image_version: input.imageVersion,
      workspace_path: input.workspacePath,
      sandbox_backend: input.sandboxBackend,
    })

    const hostToken = token()
    const clientToken = token()
    const activityToken = token()
    await db.insert(WorkerTokenTable).values([
      {
        id: createDenTypeId("workerToken"),
        worker_id: workerId,
        scope: "host",
        token: hostToken,
      },
      {
        id: createDenTypeId("workerToken"),
        worker_id: workerId,
        scope: "client",
        token: clientToken,
      },
      {
        id: createDenTypeId("workerToken"),
        worker_id: workerId,
        scope: "activity",
        token: activityToken,
      },
    ])

    if (input.destination === "cloud") {
      void continueCloudProvisioning({
        workerId,
        name: input.name,
        hostToken,
        clientToken,
        activityToken,
      })
    }

    return c.json({
      worker: toWorkerResponse(
        {
          id: workerId,
          org_id: orgId,
          created_by_user_id: user.id,
          name: input.name,
          description: input.description ?? null,
          destination: input.destination,
          status: workerStatus,
          image_version: input.imageVersion ?? null,
          workspace_path: input.workspacePath ?? null,
          sandbox_backend: input.sandboxBackend ?? null,
          last_heartbeat_at: null,
          last_active_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
        user.id,
      ),
      tokens: {
        owner: hostToken,
        host: hostToken,
        client: clientToken,
      },
      instance: null,
      launch: input.destination === "cloud" ? { mode: "async", pollAfterMs: 5000 } : { mode: "instant", pollAfterMs: 0 },
    }, input.destination === "cloud" ? 202 : 201)
  })

  app.get("/v1/workers/:id", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), async (c) => {
    const user = c.get("user")
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

    const instance = await getLatestWorkerInstance(worker.id)

    return c.json({
      worker: toWorkerResponse(worker, user.id),
      instance: toInstanceResponse(instance),
    })
  })

  app.patch("/v1/workers/:id", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), jsonValidator(updateWorkerSchema), async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const params = c.req.valid("param")
    const input = c.req.valid("json")

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

    if (worker.created_by_user_id !== user.id) {
      return c.json({
        error: "forbidden",
        message: "Only the worker owner can rename this sandbox.",
      }, 403)
    }

    await db.update(WorkerTable).set({ name: input.name }).where(eq(WorkerTable.id, workerId))

    return c.json({
      worker: toWorkerResponse(
        {
          ...worker,
          name: input.name,
          updated_at: new Date(),
        },
        user.id,
      ),
    })
  })

  app.post("/v1/workers/:id/tokens", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), async (c) => {
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

    const resolved = await getWorkerTokensAndConnect(worker)
    if ("error" in resolved && resolved.error) {
      return new Response(JSON.stringify(resolved.error.body), {
        status: resolved.error.status,
        headers: {
          "Content-Type": "application/json",
        },
      })
    }

    return c.json(resolved)
  })

  app.delete("/v1/workers/:id", requireUserMiddleware, resolveUserOrganizationsMiddleware, paramValidator(workerIdParamSchema), async (c) => {
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

    await deleteWorkerCascade(worker)
    return c.body(null, 204)
  })
}
