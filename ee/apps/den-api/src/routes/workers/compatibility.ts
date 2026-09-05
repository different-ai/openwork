import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { cors } from "hono/cors"
import { tokenRoute } from "../../middleware/index.js"
import {
  proxyCloudWorkerCompatibilityRequest,
  type CloudWorkerCompatibilityOptions,
} from "../../workers/worker-compatibility-proxy.js"
import type { WorkerRouteVariables } from "./shared.js"

type WorkerId = Parameters<typeof proxyCloudWorkerCompatibilityRequest>[0]["workerId"]

function unauthorizedResponse() {
  return Response.json({ error: "unauthorized" }, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  })
}

function cloudWorkerCompatibilityCors() {
  return cors({
    origin: (origin) => origin,
    allowHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "Last-Event-ID",
      "X-OpenCode-Directory",
      "X-OpenWork-Client-Id",
      "X-OpenWork-Host-Token",
      "X-Opencode-Directory",
    ],
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  })
}

export function registerCloudWorkerCompatibilityPreflightRoute<T extends { Variables: WorkerRouteVariables }>(
  app: Hono<T>,
) {
  app.options("/v1/cloud/workers/*", cloudWorkerCompatibilityCors())
}

export function registerCloudWorkerCompatibilityRoutes<T extends { Variables: WorkerRouteVariables }>(
  app: Hono<T>,
  options: CloudWorkerCompatibilityOptions = {},
) {
  // Worker credentials are explicit bearer values rather than ambient browser
  // credentials, so reflecting the caller lets published desktop WebViews keep
  // streaming after the Daytona preview origin rotates.
  app.use("/v1/cloud/workers/*", cloudWorkerCompatibilityCors())

  app.all("/v1/cloud/workers/:workerId/*", tokenRoute, async (c) => {
    let workerId: WorkerId
    try {
      workerId = normalizeDenTypeId("worker", c.req.param("workerId"))
    } catch {
      return unauthorizedResponse()
    }
    return proxyCloudWorkerCompatibilityRequest({ request: c.req.raw, workerId }, options)
  })
}
