import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { jsonValidator, paramValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  activityHeartbeatSchema,
  newerDate,
  parseHeartbeatTimestamp,
  parseWorkerIdParam,
  readBearerToken,
  workerIdParamSchema,
  type WorkerRouteVariables,
} from "./shared.js"

const workerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  workerId: z.string(),
  isActiveRecently: z.boolean(),
  openSessionCount: z.number().int().nullable(),
  lastHeartbeatAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().nullable(),
}).meta({ ref: "WorkerHeartbeatResponse" })

export function registerWorkerActivityRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/workers/:id/activity-heartbeat",
    describeRoute({
      tags: ["Workers", "Worker Activity"],
      summary: "Record worker heartbeat",
      description: "Accepts signed heartbeat and recent-activity updates from a worker so Den can track worker health and recent usage.",
      responses: {
        200: jsonResponse("Worker heartbeat accepted successfully.", workerHeartbeatResponseSchema),
        400: jsonResponse("The heartbeat payload or worker path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The worker heartbeat token was missing or invalid.", unauthorizedSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    paramValidator(workerIdParamSchema),
    jsonValidator(activityHeartbeatSchema),
    async (c) => {
    const params = c.req.valid("param")
    const body = c.req.valid("json")

    let workerId
    try {
      workerId = parseWorkerIdParam(params.id)
    } catch {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const authorization =
      readBearerToken(c.req.header("authorization") ?? undefined) ??
      (c.req.header("x-den-worker-heartbeat-token")?.trim() || null)

    if (!authorization) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const tokenRows = await db
      .select({ id: WorkerTokenTable.id })
      .from(WorkerTokenTable)
      .where(
        and(
          eq(WorkerTokenTable.worker_id, workerId),
          eq(WorkerTokenTable.scope, "activity"),
          eq(WorkerTokenTable.token, authorization),
          isNull(WorkerTokenTable.revoked_at),
        ),
      )
      .limit(1)

    if (tokenRows.length === 0) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const workerRows = await db
      .select()
      .from(WorkerTable)
      .where(eq(WorkerTable.id, workerId))
      .limit(1)

    const worker = workerRows[0]
    if (!worker) {
      return c.json({ error: "worker_not_found" }, 404)
    }

    const heartbeatAt = parseHeartbeatTimestamp(body.sentAt) ?? new Date()
    const requestedActivityAt = parseHeartbeatTimestamp(body.lastActivityAt ?? null)
    const activityAt = body.isActiveRecently ? (requestedActivityAt ?? heartbeatAt) : null

    const nextHeartbeatAt = newerDate(worker.last_heartbeat_at, heartbeatAt)
    const nextActiveAt = body.isActiveRecently
      ? newerDate(worker.last_active_at, activityAt)
      : worker.last_active_at

    await db
      .update(WorkerTable)
      .set({
        last_heartbeat_at: nextHeartbeatAt,
        last_active_at: nextActiveAt,
      })
      .where(eq(WorkerTable.id, workerId))

    return c.json({
      ok: true,
      workerId,
      isActiveRecently: body.isActiveRecently,
      openSessionCount: body.openSessionCount ?? null,
      lastHeartbeatAt: nextHeartbeatAt,
      lastActiveAt: nextActiveAt,
    })
    },
  )
}
