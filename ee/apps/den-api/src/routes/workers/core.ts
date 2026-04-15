import { desc, eq } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, queryValidator, requireUserMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
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

const workerInstanceSchema = z.object({
  provider: z.string(),
  region: z.string().nullable(),
  url: z.string().nullable(),
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
}).meta({ ref: "WorkerListResponse" })

const workerResponseSchema = z.object({
  worker: workerSchema,
  instance: workerInstanceSchema,
}).meta({ ref: "WorkerResponse" })

const workerCreateResponseSchema = z.object({
  worker: workerSchema,
  tokens: z.object({
    owner: z.string(),
    host: z.string(),
    client: z.string(),
  }),
  instance: workerInstanceSchema,
  launch: z.object({
    mode: z.string(),
    pollAfterMs: z.number().int(),
  }),
}).meta({ ref: "WorkerCreateResponse" })

const workerTokensResponseSchema = z.object({
  tokens: z.object({
    owner: z.string(),
    host: z.string(),
    client: z.string(),
  }),
  connect: z.object({
    openworkUrl: z.string().nullable(),
    workspaceId: z.string().nullable(),
  }).nullable(),
}).meta({ ref: "WorkerTokensResponse" })

const organizationUnavailableSchema = z.object({
  error: z.literal("organization_unavailable"),
}).meta({ ref: "OrganizationUnavailableError" })

const workspacePathRequiredSchema = z.object({
  error: z.literal("workspace_path_required"),
}).meta({ ref: "WorkspacePathRequiredError" })

const orgLimitReachedSchema = z.object({
  error: z.literal("org_limit_reached"),
  limitType: z.literal("workers"),
  limit: z.number().int(),
  currentCount: z.number().int(),
  message: z.string(),
}).meta({ ref: "WorkerOrgLimitReachedError" })

const workerRuntimeUnavailableSchema = z.object({
  error: z.literal("worker_tokens_unavailable"),
  message: z.string(),
}).or(z.object({
  error: z.literal("worker_runtime_unavailable"),
  message: z.string(),
})).meta({ ref: "WorkerConnectionError" })

export function registerWorkerCoreRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workers",
    describeRoute({
      tags: ["Workers"],
      summary: "List workers",
      description: "Lists the workers that belong to the caller's active organization, including each worker's latest known instance state.",
      responses: {
        200: jsonResponse("Workers returned successfully.", workerListResponseSchema),
        400: jsonResponse("The worker list query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to list workers.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    queryValidator(listWorkersQuerySchema),
    async (c) => {
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
    },
  )

  app.post(
    "/v1/workers",
    describeRoute({
      tags: ["Workers"],
      summary: "Create worker",
      description: "Creates a local or cloud worker for the active organization and returns the initial tokens needed to connect to it.",
      responses: {
        201: jsonResponse("Local worker created successfully.", workerCreateResponseSchema),
        202: jsonResponse("Cloud worker creation started successfully.", workerCreateResponseSchema),
        400: jsonResponse("The worker creation payload was invalid.", z.union([invalidRequestSchema, organizationUnavailableSchema, workspacePathRequiredSchema])),
        401: jsonResponse("The caller must be signed in to create workers.", unauthorizedSchema),
        409: jsonResponse("The organization has reached its worker limit.", orgLimitReachedSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    jsonValidator(createWorkerSchema),
    async (c) => {
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
    },
  )

  app.get(
    "/v1/workers/:id",
    describeRoute({
      tags: ["Workers"],
      summary: "Get worker",
      description: "Returns one worker from the active organization together with its latest provisioned instance details.",
      responses: {
        200: jsonResponse("Worker returned successfully.", workerResponseSchema),
        400: jsonResponse("The worker path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to read worker details.", unauthorizedSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    paramValidator(workerIdParamSchema),
    async (c) => {
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
    },
  )

  app.patch(
    "/v1/workers/:id",
    describeRoute({
      tags: ["Workers"],
      summary: "Update worker",
      description: "Renames a worker, but only when the caller is the user who originally created that worker.",
      responses: {
        200: jsonResponse("Worker updated successfully.", z.object({ worker: workerSchema }).meta({ ref: "WorkerUpdateResponse" })),
        400: jsonResponse("The worker update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update workers.", unauthorizedSchema),
        403: jsonResponse("Only the worker owner can rename this worker.", forbiddenSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    paramValidator(workerIdParamSchema),
    jsonValidator(updateWorkerSchema),
    async (c) => {
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
        message: "Only the worker owner can rename this worker.",
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
    },
  )

  app.post(
    "/v1/workers/:id/tokens",
    describeRoute({
      tags: ["Workers"],
      summary: "Get worker connection tokens",
      description: "Returns connection tokens and the resolved OpenWork connect URL for an existing worker.",
      responses: {
        200: jsonResponse("Worker connection tokens returned successfully.", workerTokensResponseSchema),
        400: jsonResponse("The worker token path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to request worker tokens.", unauthorizedSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
        409: jsonResponse("The worker is not ready to return connection tokens yet.", workerRuntimeUnavailableSchema),
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
    },
  )

  app.delete(
    "/v1/workers/:id",
    describeRoute({
      tags: ["Workers"],
      summary: "Delete worker",
      description: "Deletes a worker and cascades cleanup for its tokens, runtime records, and provider-specific resources.",
      responses: {
        204: emptyResponse("Worker deleted successfully."),
        400: jsonResponse("The worker deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete workers.", unauthorizedSchema),
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

    await deleteWorkerCascade(worker)
    return c.body(null, 204)
    },
  )
}
