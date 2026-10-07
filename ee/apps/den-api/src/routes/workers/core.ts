import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { nextCursorSchema } from "../../list-pagination.js"
import { orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listWorkersPage } from "../../workers/list.js"
import type { WorkerRouteVariables } from "./shared.js"
import {
  canControlWorker,
  deleteWorkerCascade,
  getLatestWorkerInstance,
  getWorkerByIdForOrg,
  listWorkersQuerySchema,
  parseWorkerIdParam,
  toInstanceResponse,
  toWorkerResponse,
  workerControlForbiddenPayload,
  workerIdParamSchema,
} from "./shared.js"

const workerInstanceSchema = z.object({
  provider: z.string(),
  region: z.string().nullable(),
  url: z.string().nullable(),
  endpointKind: z.enum(["signed-expiring", "stable", "den-tunnel"]).describe(
    "How the instance endpoint behaves. Anything other than stable means only Den's lifecycle route is durable.",
  ),
  status: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).nullable().meta({ ref: "WorkerInstance" })

const workerSchema = z.object({
  id: denTypeIdSchema("worker"),
  orgId: denTypeIdSchema("organization"),
  createdByUserId: denTypeIdSchema("user").nullable(),
  isMine: z.boolean(),
  name: z.string(),
  description: z.string().nullable(),
  destination: z.string(),
  status: z.string(),
  imageVersion: z.string().nullable(),
  workspacePath: z.string().nullable(),
  sandboxBackend: z.string().nullable(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  lastActiveAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "Worker" })

const workerListResponseSchema = z.object({
  workers: z.array(z.object({
    instance: workerInstanceSchema,
  }).merge(workerSchema)),
  nextCursor: nextCursorSchema,
}).meta({ ref: "WorkerListResponse" })

export function registerWorkerCoreRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workers",
    describeRoute({
      tags: ["Workers"],
      summary: "List workers",
      description: "Lists the workers that belong to the caller's active organization, newest first, including each worker's latest known instance state. "
        + "Pass nextCursor from the previous page as cursor to continue; nextCursor is null on the last page.",
      responses: {
        200: jsonResponse("Workers returned successfully.", workerListResponseSchema),
        400: jsonResponse("The worker list query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list workers.", unauthorizedSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
    queryValidator(listWorkersQuerySchema),
    async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const query = c.req.valid("query")

    if (!orgId) {
      return c.json({ workers: [], nextCursor: null })
    }

    const { items: rows, nextCursor } = await listWorkersPage({ orgId, limit: query.limit, cursor: query.cursor })

    const workers = await Promise.all(
      rows.map(async (row) => {
        const instance = await getLatestWorkerInstance(row.id)
        return {
          ...toWorkerResponse(row, user.id),
          instance: toInstanceResponse(instance),
        }
      }),
    )

    return c.json({ workers, nextCursor })
    },
  )

  app.delete(
    "/v1/workers/:id",
    describeRoute({
      tags: ["Workers"],
      summary: "Delete worker",
      description: "Deletes a worker and cascades cleanup for its tokens, runtime records, and provider-specific resources. Only the creator can delete a cloud worker.",
      responses: {
        204: emptyResponse("Worker deleted successfully."),
        400: jsonResponse("The worker deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete workers.", unauthorizedSchema),
        403: jsonResponse("Only the worker owner can delete this cloud worker.", forbiddenSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
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

    if (!canControlWorker(worker, c.get("user")?.id)) {
      return c.json(workerControlForbiddenPayload(), 403)
    }

    await deleteWorkerCascade(worker)
    return c.body(null, 204)
    },
  )
}
