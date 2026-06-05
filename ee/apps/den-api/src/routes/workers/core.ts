import { and, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, paramValidator, queryValidator, requireUserMiddleware, resolveOrganizationContextMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { getOrganizationLimitStatus } from "../../organization-limits.js"
import { getRequiredUserEmail } from "../../user.js"
import type { WorkerRouteVariables } from "./shared.js"
import {
  continueCloudProvisioning,
  attachStaticWorkerSchema,
  canAttachStaticWorkerForMember,
  createWorkerSchema,
  deleteWorkerCascade,
  getLatestWorkerInstance,
  getWorkerByIdForOrg,
  getWorkerTokensAndConnect,
  listWorkersQuerySchema,
  parseWorkerIdParam,
  requireCloudAccessOrPayment,
  toInstanceResponse,
  toWorkerResponse,
  token,
  updateWorkerSchema,
  type ValidatedStaticWorkerAttachUrl,
  validateResolvedStaticWorkerAttachUrl,
  withStaticAssignmentLock,
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

const staticWorkerAttachResponseSchema = z.object({
  worker: workerSchema,
  instance: workerInstanceSchema,
  launch: z.object({
    mode: z.literal("attached"),
    pollAfterMs: z.literal(0),
  }),
}).meta({ ref: "StaticWorkerAttachResponse" })

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

const paymentRequiredSchema = z.object({
  error: z.literal("cloud_worker_billing_unavailable"),
  message: z.string(),
}).meta({ ref: "WorkerPaymentRequiredError" })

const userEmailRequiredSchema = z.object({
  error: z.literal("user_email_required"),
}).meta({ ref: "WorkerUserEmailRequiredError" })

const workerRuntimeUnavailableSchema = z.object({
  error: z.literal("worker_tokens_unavailable"),
  message: z.string(),
}).or(z.object({
  error: z.literal("worker_runtime_unavailable"),
  message: z.string(),
})).meta({ ref: "WorkerConnectionError" })

export async function fetchStaticWorker(url: string, path: string, headers: Record<string, string>) {
  return fetch(`${url}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(env.staticWorkers.healthcheckTimeoutMs),
  })
}

function formatIpForUrl(address: string) {
  return address.includes(":") ? `[${address}]` : address
}

export async function fetchPinnedStaticWorker(target: ValidatedStaticWorkerAttachUrl, path: string, headers: Record<string, string>) {
  const original = new URL(target.url)
  const resolvedAddress = target.resolvedAddresses[0]?.address
  const pinned = resolvedAddress ? new URL(target.url) : original
  if (resolvedAddress) {
    pinned.hostname = formatIpForUrl(resolvedAddress)
  }
  const hostHeader = original.port ? `${original.hostname}:${original.port}` : original.hostname
  return fetch(`${pinned.toString().replace(/\/+$/, "")}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...(resolvedAddress && original.protocol === "http:" ? { Host: hostHeader } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(env.staticWorkers.healthcheckTimeoutMs),
  })
}

export async function assertStaticWorkerReachable(url: string | ValidatedStaticWorkerAttachUrl, clientToken: string, hostToken: string) {
  const fetchWorker = typeof url === "string"
    ? (path: string, headers: Record<string, string>) => fetchStaticWorker(url, path, headers)
    : (path: string, headers: Record<string, string>) => fetchPinnedStaticWorker(url, path, headers)

  const clientResponse = await fetchWorker("/workspaces", {
    Authorization: `Bearer ${clientToken}`,
  })

  if (!clientResponse.ok) {
    throw new Error(`Worker rejected the provided client token with HTTP ${clientResponse.status}`)
  }

  const hostResponse = await fetchWorker("/env/keys", {
    "X-OpenWork-Host-Token": hostToken,
  })

  if (!hostResponse.ok) {
    throw new Error(`Worker rejected the provided host token with HTTP ${hostResponse.status}`)
  }
}

type StaticAttachTx = Pick<typeof db, "insert" | "select">
type StaticAttachInput = z.infer<typeof attachStaticWorkerSchema>
type StaticAttachRouteDeps = {
  middlewares?: MiddlewareHandler<{ Variables: WorkerRouteVariables }>[]
  data?: StaticAttachTx
  lookup?: Parameters<typeof validateResolvedStaticWorkerAttachUrl>[2]
  fetchReachable?: (url: ValidatedStaticWorkerAttachUrl, clientToken: string, hostToken: string) => Promise<void>
  lock?: <T>(run: (tx: StaticAttachTx) => Promise<T>) => Promise<T>
  getWorkerLimit?: typeof getOrganizationLimitStatus
}

async function findActiveStaticWorkerByUrl(tx: Pick<typeof db, "select">, normalizedUrl: string) {
  return tx
    .select({ id: WorkerInstanceTable.id })
    .from(WorkerInstanceTable)
    .where(
      and(
        eq(WorkerInstanceTable.provider, "static"),
        eq(WorkerInstanceTable.url, normalizedUrl),
        inArray(WorkerInstanceTable.status, ["provisioning", "healthy"]),
      ),
    )
    .limit(1)
}

function staticAttachDuplicateResponse() {
  return {
    error: "worker_url_already_attached",
    message: "This static worker URL is already attached to an active Den worker.",
  }
}

export function registerStaticWorkerAttachRoute(app: Hono<{ Variables: WorkerRouteVariables }>, deps: StaticAttachRouteDeps = {}) {
  const routeMiddlewares = deps.middlewares ?? [requireUserMiddleware, resolveOrganizationContextMiddleware, jsonValidator(attachStaticWorkerSchema)]
  const data = deps.data ?? db
  const fetchReachable = deps.fetchReachable ?? assertStaticWorkerReachable
  const lock = deps.lock ?? ((run) => withStaticAssignmentLock(run))
  const getWorkerLimit = deps.getWorkerLimit ?? getOrganizationLimitStatus

  app.post(
    "/v1/workers/static-attach",
    describeRoute({
      tags: ["Workers"],
      summary: "Attach static worker",
      description: "Registers a pre-running LAN/OpenWork worker for the active organization using its existing runtime URL and tokens.",
      responses: {
        201: jsonResponse("Static worker attached successfully.", staticWorkerAttachResponseSchema),
        400: jsonResponse("The static worker attach payload was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to attach workers.", unauthorizedSchema),
        403: jsonResponse("Only organization owners and admins can attach static workers.", forbiddenSchema),
        409: jsonResponse("The organization has reached its worker limit or the URL is already attached.", orgLimitReachedSchema.or(z.object({ error: z.literal("worker_url_already_attached"), message: z.string() }))),
      },
    }),
    ...(routeMiddlewares as never[]),
    async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const organizationContext = c.get("organizationContext")
    const input = c.req.valid("json" as never) as StaticAttachInput

    if (!user?.id) {
      return c.json({ error: "unauthorized" }, 401)
    }

    if (!orgId) {
      return c.json({ error: "organization_unavailable" }, 400)
    }

    const normalizedOrgId = normalizeDenTypeId("organization", orgId)
    const normalizedUserId = normalizeDenTypeId("user", user.id)

    if (!organizationContext || !canAttachStaticWorkerForMember(organizationContext)) {
      return c.json({
        error: "forbidden",
        message: "Only organization owners and admins can attach static workers.",
      }, 403)
    }

    const validatedUrl = await validateResolvedStaticWorkerAttachUrl(input.url, {
      allowPrivate: env.staticWorkers.allowPrivateAttach,
      allowedHosts: env.staticWorkers.attachAllowedHosts,
      allowedCidrs: env.staticWorkers.attachAllowedCidrs,
    }, deps.lookup)
    if (!validatedUrl.ok) {
      return c.json({ error: "invalid_request", message: validatedUrl.message }, 400)
    }

    const normalizedUrl = validatedUrl.url
    const existing = await findActiveStaticWorkerByUrl(data, normalizedUrl)
    if (existing.length > 0) {
      return c.json(staticAttachDuplicateResponse(), 409)
    }

    try {
      await fetchReachable(validatedUrl, input.clientToken.trim(), input.hostToken.trim())
    } catch (error) {
      return c.json({
        error: "invalid_request",
        message: "Static worker verification failed with the provided URL and tokens.",
      }, 400)
    }

    const workerId = createDenTypeId("worker")
    const instanceId = createDenTypeId("workerInstance")
    const activityToken = input.activityToken?.trim() || token()
    const now = new Date()

    const insertResult = await lock(async (tx) => {
      const duplicateRows = await findActiveStaticWorkerByUrl(tx, normalizedUrl)
      if (duplicateRows.length > 0) {
        return { status: "duplicate" as const }
      }

      const workerLimit = await getWorkerLimit(normalizedOrgId, "workers")
      if (workerLimit.exceeded) {
        return { status: "limit" as const, workerLimit }
      }

      await tx.insert(WorkerTable).values({
        id: workerId,
        org_id: normalizedOrgId,
        created_by_user_id: normalizedUserId,
        name: input.name,
        description: input.description?.trim() || null,
        destination: "cloud",
        status: "healthy",
        image_version: null,
        workspace_path: null,
        sandbox_backend: "static",
      } as never)

      await tx.insert(WorkerTokenTable).values([
        {
          id: createDenTypeId("workerToken"),
          worker_id: workerId,
          scope: "host",
          token: input.hostToken.trim(),
        },
        {
          id: createDenTypeId("workerToken"),
          worker_id: workerId,
          scope: "client",
          token: input.clientToken.trim(),
        },
        {
          id: createDenTypeId("workerToken"),
          worker_id: workerId,
          scope: "activity",
          token: activityToken,
        },
      ] as never)

      await tx.insert(WorkerInstanceTable).values({
        id: instanceId,
        worker_id: workerId,
        provider: "static",
        region: "on-prem",
        url: normalizedUrl,
        status: "healthy",
      } as never)
      return { status: "inserted" as const }
    })

    if (insertResult.status === "duplicate") {
      return c.json(staticAttachDuplicateResponse(), 409)
    }

    if (insertResult.status === "limit") {
      return c.json({
        error: "org_limit_reached",
        limitType: "workers",
        limit: insertResult.workerLimit.limit,
        currentCount: insertResult.workerLimit.currentCount,
        message: `This workspace currently supports up to ${insertResult.workerLimit.limit} workers. Contact support to increase the limit.`,
      }, 409)
    }

    return c.json({
      worker: toWorkerResponse(
        {
          id: workerId,
          org_id: normalizedOrgId,
          created_by_user_id: normalizedUserId,
          name: input.name,
          description: input.description?.trim() || null,
          destination: "cloud",
          status: "healthy",
          image_version: null,
          workspace_path: null,
          sandbox_backend: "static",
          last_heartbeat_at: null,
          last_active_at: null,
          created_at: now,
          updated_at: now,
        },
        normalizedUserId,
      ),
      instance: toInstanceResponse({
        id: instanceId,
        worker_id: workerId,
        provider: "static",
        region: "on-prem",
        url: normalizedUrl,
        status: "healthy",
        created_at: now,
        updated_at: now,
      }),
      launch: { mode: "attached", pollAfterMs: 0 },
    }, 201)
    },
  )
}

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
      description: "Creates a local worker or cloud worker for the active organization and returns the initial tokens needed to connect to it.",
      responses: {
        201: jsonResponse("Local worker created successfully.", workerCreateResponseSchema),
        202: jsonResponse("Cloud worker creation started successfully.", workerCreateResponseSchema),
        400: jsonResponse("The worker creation payload was invalid.", z.union([invalidRequestSchema, organizationUnavailableSchema, workspacePathRequiredSchema, userEmailRequiredSchema])),
        401: jsonResponse("The caller must be signed in to create workers.", unauthorizedSchema),
        402: jsonResponse("The caller needs an active cloud plan before launching a cloud worker.", paymentRequiredSchema),
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
      const email = getRequiredUserEmail(user)
      if (!email) {
        return c.json({ error: "user_email_required" }, 400)
      }

      const access = await requireCloudAccessOrPayment({
        userId: normalizeDenTypeId("user", user.id),
        email,
        name: user.name ?? user.email ?? "OpenWork User",
      })

      if (!access.allowed) {
        return c.json({
          error: "cloud_worker_billing_unavailable",
          message: "Creating new cloud workers requires an existing OpenWork Cloud plan. New self-serve purchases are no longer available.",
        }, 402)
      }

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

  registerStaticWorkerAttachRoute(app as unknown as Hono<{ Variables: WorkerRouteVariables }>)

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
